#!/usr/bin/env node

/**
 * Full Audit
 * ──────────
 * Comprehensive audit that runs every metric in the toolkit.
 * This is the "leave nothing unchecked" command — expect 5-10 minutes.
 *
 * Runs ALL of:
 *   §2 — Responsive & Cross-Browser (breakpoint screenshots + overflow check)
 *   §3 — Performance (Lighthouse mobile + desktop + Core Web Vitals + 3G throttle)
 *   §4 — SEO (meta tags, OG, Twitter Card, JSON-LD, semantic HTML, headings, alt text, SSR)
 *   §7 — Accessibility (full axe-core WCAG 2.1 AA scan with violation details)
 *   §9 — Redirects & Routing (404 page + internal link check)
 *
 * Usage:
 *   node scripts/full-audit.js https://preview-url.vercel.app
 *   node scripts/full-audit.js https://preview-url.vercel.app --password mypass
 *   node scripts/full-audit.js https://preview-url.vercel.app --browsers chromium,webkit,firefox
 *   node scripts/full-audit.js https://preview-url.vercel.app --redirects redirects.json
 */

import { chromium } from 'playwright';
import { createCLI, resolveArgs } from '../lib/cli.js';
import {
  LIGHTHOUSE, ACCESSIBILITY, SEO, BREAKPOINTS, REDIRECTS, PAGESPEED
} from '../lib/config.js';
import { vercelAuth, cookiesToString } from '../lib/vercel-auth.js';
import {
  heading, subheading, pass, fail, warn, info,
  printChecks, saveReport, buildSummary
} from '../lib/report.js';
import { runLighthouseAudit } from '../lib/runners/lighthouse.js';
import { runAccessibilityAudit } from '../lib/runners/accessibility.js';
import { runBreakpointTest } from '../lib/runners/breakpoints.js';
import { runSeoAudit } from '../lib/runners/seo.js';
import { runRedirectChecker } from '../lib/runners/redirects.js';
import { runPagespeedAudit } from '../lib/runners/pagespeed.js';

// ── CLI Setup ──────────────────────────────────────────────
const program = createCLI(
  'full-audit',
  'Run every QA metric: Lighthouse, accessibility, breakpoints, SEO, redirects & links'
);

program
  .option('--browsers <browsers>', 'Browsers to test (comma-separated: chromium,webkit,firefox)', 'chromium,webkit,firefox')
  .option('--full-page', 'Capture full-page screenshots')
  .option('--redirects <file>', 'JSON file with redirect map [{from, to}]')
  .option('--psi-api-key <key>', 'Google PSI API key for PageSpeed diagnostics CrUX data')
  .option('--skip <sections>', 'Comma-separated sections to skip (lighthouse,pagespeed,accessibility,breakpoints,seo,redirects)')
  .parse(process.argv);

const args = resolveArgs(program);
const skip = new Set((args.skip || '').split(',').map(s => s.trim()).filter(Boolean));

// ── Main ───────────────────────────────────────────────────
async function run() {
  const startTime = Date.now();
  heading(`Full Audit: ${args.url}`);
  console.log('');
  info('This runs every metric — expect 5-10 minutes.');
  console.log('');

  // ── Authenticate once, share cookies everywhere ─────────
  let authCookies = '';
  let authCookieObjects = null;
  if (args.password) {
    info('Authenticating with Vercel preview...');
    const authBrowser = await chromium.launch({ headless: true });
    const auth = await vercelAuth(authBrowser, args.url, args.password);
    authCookies = cookiesToString(auth.cookies);
    authCookieObjects = auth.cookies;
    await auth.context.close();
    await authBrowser.close();
    pass('Authenticated');
  }

  const results = {};
  let totalFails = 0;
  const sectionResults = {};

  // ════════════════════════════════════════════════════════════
  // §3 — LIGHTHOUSE (Performance + SEO scores + Core Web Vitals)
  // ════════════════════════════════════════════════════════════
  if (!skip.has('lighthouse')) {
    heading('§3 Performance — Lighthouse');

    const lhResult = await runLighthouseAudit({
      url: args.url,
      authCookies,
      options: { strategy: 'both', throttle3g: true },
    });

    // Print per-strategy results
    for (const [strategy, data] of Object.entries(lhResult.data)) {
      if (strategy === '3g') {
        subheading('3G Throttled Test ("Namibia Test")');
        printChecks(data.checks);
        continue;
      }

      subheading(`Lighthouse — ${strategy === 'mobile' ? 'Mobile' : 'Desktop'}`);
      info(`Scores: Performance ${data.scores.performance} | SEO ${data.scores.seo} | Accessibility ${data.scores.accessibility} | Best Practices ${data.scores.bestPractices}`);
      console.log('');
      printChecks(data.checks);

      if (data.failedAudits.length > 0) {
        console.log('');
        warn(`${data.failedAudits.length} audits scored below 50%:`);
        data.failedAudits.slice(0, LIGHTHOUSE.display.failedAuditLimitFull).forEach(a => {
          console.log(`     • ${a.title} (${Math.round(a.score * 100)}%)`);
        });
        if (data.failedAudits.length > LIGHTHOUSE.display.failedAuditLimitFull) {
          console.log(`     ... and ${data.failedAudits.length - LIGHTHOUSE.display.failedAuditLimitFull} more`);
        }
      }
    }

    results.lighthouseMobile = lhResult.data.mobile ? {
      scores: lhResult.data.mobile.scores,
      coreWebVitals: lhResult.data.mobile.coreWebVitals,
      failedAudits: lhResult.data.mobile.failedAudits,
    } : null;

    results.lighthouseDesktop = lhResult.data.desktop ? {
      scores: lhResult.data.desktop.scores,
      coreWebVitals: lhResult.data.desktop.coreWebVitals,
      failedAudits: lhResult.data.desktop.failedAudits,
    } : null;

    results.lighthouse3g = lhResult.data['3g'] || null;

    totalFails += lhResult.failCount;
    sectionResults.lighthouse = { fails: lhResult.failCount };
  }

  // ════════════════════════════════════════════════════════════
  // §3b — PAGESPEED DIAGNOSTICS (Render-blocking, long tasks, coverage)
  // ════════════════════════════════════════════════════════════
  if (!skip.has('pagespeed')) {
    heading('§3b Performance — PageSpeed Diagnostics');

    const psResult = await runPagespeedAudit({
      url: args.url,
      authCookieObjects,
      options: {
        detailed: true,
        apiKey: args.psiApiKey || null,
        strategy: 'both',
      },
    });

    const PD = PAGESPEED.display;

    for (const [strategy, d] of Object.entries(psResult.data)) {
      const strategyLabel = strategy === 'mobile' ? 'Mobile' : 'Desktop';
      const psData = d.data;

      subheading(`PageSpeed — ${strategyLabel}`);

      // Core Web Vitals
      printChecks(d.checks.filter(c => c.category === 'coreWebVitals'));

      if (psData.lcp) {
        info(`LCP element: <${psData.lcp.tagName}> ${psData.lcp.selector}`);
      }

      // Render-Blocking
      printChecks(d.checks.filter(c => c.category === 'renderBlocking'));

      if (psData.renderBlocking.length > 0) {
        psData.renderBlocking.slice(0, PD.renderBlockingLimitFull).forEach(r => {
          const url = r.url.length > PD.urlTruncate ? r.url.slice(0, PD.urlTruncate - 3) + '...' : r.url;
          console.log(`     • [${r.type}] ${url} (${Math.round(r.duration)}ms)`);
        });
        if (psData.renderBlocking.length > PD.renderBlockingLimitFull) {
          console.log(`     ... and ${psData.renderBlocking.length - PD.renderBlockingLimitFull} more`);
        }
      }

      // Main Thread
      printChecks(d.checks.filter(c => c.category === 'mainThread'));

      if (psData.longTasks.length > 0) {
        psData.longTasks
          .sort((a, b) => b.duration - a.duration)
          .slice(0, PD.longTaskLimitFull)
          .forEach(t => {
            console.log(`     • ${Math.round(t.duration)}ms at ${Math.round(t.startTime)}ms`);
          });
        if (psData.longTasks.length > PD.longTaskLimitFull) {
          console.log(`     ... and ${psData.longTasks.length - PD.longTaskLimitFull} more`);
        }
      }

      // Resource Efficiency
      printChecks(d.checks.filter(c => c.category === 'resourceEfficiency'));

      if (psData.coverage && psData.coverage.jsBundles.length > 0) {
        psData.coverage.jsBundles.slice(0, PD.unusedBundleLimitFull).forEach(b => {
          const url = b.url.length > PD.urlTruncate ? b.url.slice(0, PD.urlTruncate - 3) + '...' : b.url;
          console.log(`     • ${b.unusedPercent}% unused — ${url}`);
        });
        if (psData.coverage.jsBundles.length > PD.unusedBundleLimitFull) {
          console.log(`     ... and ${psData.coverage.jsBundles.length - PD.unusedBundleLimitFull} more`);
        }
      }

      // Layout shift sources
      if (psData.shiftSources.length > 0) {
        info('Layout shift sources:');
        psData.shiftSources.slice(0, PD.shiftSourceLimitFull).forEach(s => {
          console.log(`     • ${s.selector}`);
        });
        if (psData.shiftSources.length > PD.shiftSourceLimitFull) {
          console.log(`     ... and ${psData.shiftSources.length - PD.shiftSourceLimitFull} more`);
        }
      }

      // Critical Path (PSI only)
      if (psData.psi) {
        printChecks(d.checks.filter(c => c.category === 'criticalPath'));
      }

      for (const w of d.warnings) warn(w);
    }

    // Store per-strategy results for report
    results.pagespeed = {};
    for (const [strategy, d] of Object.entries(psResult.data)) {
      const psData = d.data;
      results.pagespeed[strategy] = {
        navigationTiming: psData.navigationTiming,
        lcp: psData.lcp,
        cls: psData.cls,
        tbt: psData.tbt,
        totalPageWeight: psData.totalPageWeight,
        renderBlockingCount: psData.renderBlocking.length,
        longTaskCount: psData.longTasks.length,
        coverage: psData.coverage ? {
          jsBundleCount: psData.coverage.jsBundles.length,
          cssUnusedPercent: psData.coverage.css.unusedPercent,
        } : null,
      };
    }

    totalFails += psResult.failCount;
    sectionResults.pagespeed = { fails: psResult.failCount };
  }

  // ════════════════════════════════════════════════════════════
  // §7 — ACCESSIBILITY (Full axe-core WCAG 2.1 AA)
  // ════════════════════════════════════════════════════════════
  if (!skip.has('accessibility')) {
    heading('§7 Accessibility — axe-core (WCAG 2.1 AA)');

    const a11yResult = await runAccessibilityAudit({
      url: args.url,
      authCookieObjects,
    });

    const { data: a11yData } = a11yResult;
    const { summary, violations } = a11yData;

    subheading('Results');
    printChecks(a11yResult.checks.filter(c => c.label === 'axe-core scan'));

    if (summary.totalViolations > 0) {
      console.log('');
      if (summary.bySeverity.critical > 0) fail(`Critical: ${summary.bySeverity.critical}`);
      if (summary.bySeverity.serious > 0)  fail(`Serious:  ${summary.bySeverity.serious}`);
      if (summary.bySeverity.moderate > 0) warn(`Moderate: ${summary.bySeverity.moderate}`);
      if (summary.bySeverity.minor > 0)    info(`Minor:    ${summary.bySeverity.minor}`);
    }

    // Violation details
    if (violations.length > 0) {
      subheading('Violation Details');

      violations.forEach((v, i) => {
        const impactIcon = v.impact === 'critical' || v.impact === 'serious' ? '❌' : '⚠️';
        console.log(`\n  ${impactIcon} ${i + 1}. [${v.impact.toUpperCase()}] ${v.help}`);
        console.log(`     Rule: ${v.id}`);
        console.log(`     WCAG: ${v.wcagTags.join(', ')}`);
        console.log(`     Affected elements (${v.nodeCount}):`);

        v.nodes.slice(0, ACCESSIBILITY.display.violationNodeLimit).forEach(node => {
          const selector = node.target.join(' > ');
          console.log(`       • ${selector}`);
          if (node.failureSummary) {
            console.log(`         ${node.failureSummary.split('\n')[0]}`);
          }
        });

        if (v.nodeCount > ACCESSIBILITY.display.violationNodeLimit) {
          console.log(`       ... and ${v.nodeCount - ACCESSIBILITY.display.violationNodeLimit} more elements`);
        }
      });
    }

    // Checklist mapping
    subheading('Checklist §7 Coverage');
    printChecks(a11yResult.checks.filter(c => c.label !== 'axe-core scan'));

    for (const mc of a11yResult.manualChecks) warn(mc);

    // Incomplete items
    if (a11yData.incompleteItems.length > 0) {
      subheading(`Manual Review Needed (${a11yData.incompleteItems.length} items)`);
      a11yData.incompleteItems.slice(0, ACCESSIBILITY.display.incompleteLimit).forEach(item => {
        console.log(`  ⚠️  ${item.help} (${item.nodeCount} elements)`);
      });
      if (a11yData.incompleteItems.length > ACCESSIBILITY.display.incompleteLimit) {
        console.log(`  ... and ${a11yData.incompleteItems.length - ACCESSIBILITY.display.incompleteLimit} more`);
      }
    }

    results.accessibility = {
      violations: violations,
      summary,
    };

    // Count section fails: checklist failures + critical/serious
    let sectionFails = a11yResult.checks.filter(c => c.label !== 'axe-core scan' && !c.passed).length;
    if (summary.bySeverity.critical > 0 || summary.bySeverity.serious > 0) sectionFails++;

    totalFails += sectionFails;
    sectionResults.accessibility = { fails: sectionFails };
  }

  // ════════════════════════════════════════════════════════════
  // §2 — RESPONSIVE & CROSS-BROWSER (Breakpoint screenshots)
  // ════════════════════════════════════════════════════════════
  if (!skip.has('breakpoints')) {
    heading('§2 Responsive & Cross-Browser — Breakpoints');

    const browsers = args.browsers.split(',').map(b => b.trim());

    info(`Browsers: ${browsers.join(', ')}`);
    info(`Breakpoints: ${BREAKPOINTS.map(b => `${b.name} (${b.width}px)`).join(', ')}`);

    const bpResult = await runBreakpointTest({
      url: args.url,
      authCookieObjects,
      options: {
        browsers,
        fullPage: args.fullPage,
      },
    });

    info(`Screenshots: ${bpResult.data.screenshotDir}`);

    for (const check of bpResult.checks) {
      if (check.passed) {
        pass(check.message);
      } else {
        fail(check.message);
        if (check.overflowing) {
          check.overflowing.forEach(el => {
            const id = el.id ? `#${el.id}` : el.class ? `.${el.class.split(' ')[0]}` : el.tag;
            console.log(`       → <${el.tag}> ${id} overflows by ${el.overflow}px`);
          });
        }
      }
    }

    for (const w of bpResult.warnings) warn(w);
    for (const mc of bpResult.manualChecks) warn(mc);

    results.breakpoints = bpResult.data.results;

    totalFails += bpResult.failCount;
    sectionResults.breakpoints = { fails: bpResult.failCount };
  }

  // ════════════════════════════════════════════════════════════
  // §4 — SEO (Full DOM audit)
  // ════════════════════════════════════════════════════════════
  if (!skip.has('seo')) {
    heading('§4 SEO — Full Audit');

    const seoResult = await runSeoAudit({
      url: args.url,
      authCookieObjects,
      options: { checkSsr: true },
    });

    const d = seoResult.data;

    // Meta Tags
    subheading('Meta Tags');
    printChecks(seoResult.checks.filter(c => ['Title tag', 'Meta description', 'Canonical URL'].includes(c.label)));
    for (const w of seoResult.warnings.filter(w => w.includes('chars'))) warn(w);

    // Open Graph
    subheading('Open Graph');
    printChecks(seoResult.checks.filter(c => c.label === 'Open Graph tags'));
    if (d.openGraph) {
      Object.entries(d.openGraph).forEach(([key, value]) => {
        if (value) info(`  ${key}: ${value.slice(0, SEO.display.ogValueTruncate)}`);
      });
    }

    // Twitter Card
    subheading('Twitter Card');
    printChecks(seoResult.checks.filter(c => c.label === 'Twitter Card tags'));

    // JSON-LD
    subheading('Structured Data (JSON-LD)');
    printChecks(seoResult.checks.filter(c => c.label === 'JSON-LD' || c.label === 'JSON-LD validity'));
    if (d.jsonLd && d.jsonLd.length > 0) {
      const types = d.jsonLd.map(j => j.type || 'Unknown');
      info(`Types: ${types.join(', ')}`);
      for (const t of SEO.expectedJsonLdTypes) {
        if (seoResult.data.jsonLd?.some(j => j.type === t)) {
          pass(`  ${t} schema present`);
        } else {
          info(`  ${t} schema not found (check if applicable to this page)`);
        }
      }
    }

    // Semantic HTML
    subheading('Semantic HTML');
    printChecks(seoResult.checks.filter(c => c.label === 'Semantic HTML' || c.label === 'H1 tag' || c.label === 'Heading hierarchy'));
    for (const w of seoResult.warnings.filter(w => w.includes('semantic') || w.includes('<h1>') || w.includes('Heading hierarchy'))) warn(w);

    // Heading hierarchy clean check
    if (d.headings && d.headings.length > 0) {
      const levels = d.headings.map(h => h.level);
      let clean = true;
      for (let i = 1; i < levels.length; i++) {
        if (levels[i] > levels[i - 1] + 1) { clean = false; break; }
      }
      if (clean && !seoResult.checks.some(c => c.label === 'Heading hierarchy')) {
        pass('Heading hierarchy is sequential (no skipped levels)');
      }
    }

    // Image Alt Text
    subheading('Image Alt Text');
    printChecks(seoResult.checks.filter(c => c.label === 'Image alt text'));
    if (d.images.missingElements?.length > 0) {
      d.images.missingElements.slice(0, SEO.display.missingAltLimit).forEach(img => {
        console.log(`     • ${img.src}`);
      });
      if (d.images.missingElements.length > SEO.display.missingAltLimit) {
        console.log(`     ... and ${d.images.missingElements.length - SEO.display.missingAltLimit} more`);
      }
    }

    // SSR
    subheading('Server-Side Rendering Check');
    printChecks(seoResult.checks.filter(c => c.label === 'SSR'));
    if (d.ssr && !d.ssr.hasContent) {
      info(`Raw HTML length without JS: ${d.ssr.htmlLength} chars`);
    }

    results.seo = d;

    totalFails += seoResult.failCount;
    sectionResults.seo = { fails: seoResult.failCount };
  }

  // ════════════════════════════════════════════════════════════
  // §9 — REDIRECTS & ROUTING (404 + internal links)
  // ════════════════════════════════════════════════════════════
  if (!skip.has('redirects')) {
    heading('§9 Redirects & Routing');

    const redirectResult = await runRedirectChecker({
      url: args.url,
      authCookieObjects,
      options: {
        redirectsFile: args.redirects,
        check404: true,
        checkLinks: true,
      },
    });

    // Redirect map
    if (args.redirects) {
      subheading('301 Redirect Validation');
      const redirectChecks = redirectResult.checks.filter(c => c.label.startsWith('Redirect '));
      for (const c of redirectChecks) {
        if (c.passed) pass(c.message);
        else fail(c.message);
      }
    }

    // Internal links
    subheading('Internal Link Check');
    const { links, externalLinks } = redirectResult.data;
    info(`Found ${links.length} internal links, ${externalLinks.length} external`);

    for (const c of redirectResult.checks.filter(c => c.label.startsWith('Link '))) {
      fail(c.message);
    }

    const linkSummary = redirectResult.checks.find(c => c.label === 'Internal links');
    if (linkSummary) pass(linkSummary.message);

    if (externalLinks.length > 0) {
      info('External links found (manual check recommended):');
      externalLinks.slice(0, REDIRECTS.display.externalLinkLimit).forEach(url => {
        console.log(`     → ${url}`);
      });
      if (externalLinks.length > REDIRECTS.display.externalLinkLimit) {
        console.log(`     ... and ${externalLinks.length - REDIRECTS.display.externalLinkLimit} more`);
      }
    }

    // Custom 404
    subheading('Custom 404 Page');
    const checks404 = redirectResult.checks.filter(c => c.label.includes('404'));
    for (const c of checks404) {
      if (c.passed) pass(c.message);
      else fail(c.message);
    }

    for (const w of redirectResult.warnings) warn(w);

    results.redirects = redirectResult.data;

    totalFails += redirectResult.failCount;
    sectionResults.redirects = { fails: redirectResult.failCount };
  }

  // ════════════════════════════════════════════════════════════
  // FINAL SUMMARY
  // ════════════════════════════════════════════════════════════
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  if (args.save) {
    const summary = buildSummary('full-audit', args.url, results);
    const filepath = saveReport('full-audit', summary);
    console.log(`\n  📄 Full report saved: ${filepath}`);
  }

  heading(`Full Audit Complete (${elapsed}s)`);

  console.log('');
  subheading('Section Summary');

  const sections = [
    { key: 'lighthouse',     label: '§3 Performance (Lighthouse)' },
    { key: 'pagespeed',      label: '§3b Performance (PageSpeed Diagnostics)' },
    { key: 'accessibility',  label: '§7 Accessibility (axe-core)' },
    { key: 'breakpoints',    label: '§2 Responsive & Cross-Browser' },
    { key: 'seo',            label: '§4 SEO' },
    { key: 'redirects',      label: '§9 Redirects & Routing' },
  ];

  sections.forEach(({ key, label }) => {
    if (skip.has(key)) {
      info(`${label}: SKIPPED`);
    } else if (sectionResults[key]?.fails === 0) {
      pass(`${label}: PASS`);
    } else {
      fail(`${label}: ${sectionResults[key]?.fails} issue(s)`);
    }
  });

  console.log('');

  if (totalFails === 0) {
    pass(`All checks passed across every section ✓`);
  } else {
    fail(`${totalFails} total issue(s) found — review details above`);
  }

  console.log('');
  warn('Manual checks still needed:');
  console.log('     • Keyboard navigation (Tab, Enter, Escape)');
  console.log('     • Focus indicator visibility');
  console.log('     • Visual comparison against Figma designs');
  console.log('     • Touch targets and iOS safe areas');
  console.log('     • External link destinations');

  process.exit(totalFails > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('\n❌ Full audit failed:', err.message);
  process.exit(2);
});
