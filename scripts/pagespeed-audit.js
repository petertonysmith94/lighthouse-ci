#!/usr/bin/env node

/**
 * PageSpeed Diagnostics Audit
 * ───────────────────────────
 * Captures detailed performance diagnostics using Playwright Performance APIs
 * and optionally enriches with Google PSI API field data.
 *
 * Covers render-blocking resources, long tasks, CLS sources, unused code,
 * resource waterfall, and critical request chains.
 *
 * Usage:
 *   node scripts/pagespeed-audit.js https://preview-url.vercel.app
 *   node scripts/pagespeed-audit.js https://preview-url.vercel.app --strategy mobile
 *   node scripts/pagespeed-audit.js https://preview-url.vercel.app --strategy desktop
 *   node scripts/pagespeed-audit.js https://preview-url.vercel.app --api-key <key>
 *   node scripts/pagespeed-audit.js https://preview-url.vercel.app --no-detailed
 *   node scripts/pagespeed-audit.js https://preview-url.vercel.app --password mypass
 */

import { chromium } from 'playwright';
import { createCLI, resolveArgs } from '../lib/cli.js';
import { PAGESPEED } from '../lib/config.js';
import { vercelAuth, cookiesToString } from '../lib/vercel-auth.js';
import {
  heading, subheading, pass, fail, warn, info,
  printChecks, saveReport, buildSummary
} from '../lib/report.js';
import { runPagespeedAudit } from '../lib/runners/pagespeed.js';

// ── CLI Setup ──────────────────────────────────────────────
const program = createCLI(
  'pagespeed-audit',
  'Run PageSpeed diagnostics: render-blocking, long tasks, CLS sources, unused code, resource waterfall'
);

program
  .option('--api-key <key>', 'Google PSI API key for CrUX field data enrichment')
  .option('-s, --strategy <strategy>', 'Device strategy: mobile, desktop, or both', 'both')
  .option('--detailed', 'Enable code coverage analysis (default: true)', true)
  .option('--no-detailed', 'Skip code coverage analysis (faster)')
  .parse(process.argv);

const args = resolveArgs(program);

// ── Helpers ────────────────────────────────────────────────
function truncateUrl(url, max) {
  if (url.length <= max) return url;
  return url.slice(0, max - 3) + '...';
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  return `${Math.round(bytes / 1024)} KB`;
}

// ── Main ───────────────────────────────────────────────────
async function run() {
  heading(`PageSpeed Diagnostics: ${args.url}`);

  // Step 1: Handle Vercel auth if needed
  let authCookieObjects = null;
  if (args.password) {
    info('Authenticating with Vercel preview...');
    const browser = await chromium.launch({ headless: true });
    const { cookies, context } = await vercelAuth(browser, args.url, args.password);
    authCookieObjects = cookies;
    await context.close();
    await browser.close();
  }

  const result = await runPagespeedAudit({
    url: args.url,
    authCookieObjects,
    options: {
      apiKey: args.apiKey,
      strategy: args.strategy,
      detailed: args.detailed,
    },
  });

  const DL = PAGESPEED.display;

  // ── Per-strategy results ─────────────────────────────────
  for (const [strategy, d] of Object.entries(result.data)) {
    const strategyLabel = strategy === 'mobile' ? 'Mobile' : 'Desktop';

    heading(`PageSpeed Diagnostics — ${strategyLabel}`);

    // Core Web Vitals
    subheading(PAGESPEED.categories.coreWebVitals.label);
    printChecks(d.checks.filter(c => c.category === 'coreWebVitals'));

    if (d.data.lcp) {
      info(`LCP element: <${d.data.lcp.tagName}> ${d.data.lcp.selector}`);
      if (d.data.lcp.url) info(`LCP resource: ${truncateUrl(d.data.lcp.url, DL.urlTruncate)}`);
    }

    // Navigation timing
    const nt = d.data.navigationTiming;
    info(`TTFB: ${Math.round(nt.ttfb)}ms | DOM Interactive: ${Math.round(nt.domInteractive)}ms | DOM Loaded: ${Math.round(nt.domContentLoaded)}ms | Load: ${Math.round(nt.loadEvent)}ms`);

    // Render-Blocking
    subheading(PAGESPEED.categories.renderBlocking.label);
    printChecks(d.checks.filter(c => c.category === 'renderBlocking'));

    if (d.data.renderBlocking.length > 0) {
      console.log('');
      info('Render-blocking resources:');
      d.data.renderBlocking.slice(0, DL.renderBlockingLimit).forEach(r => {
        const url = truncateUrl(r.url, DL.urlTruncate);
        console.log(`     • [${r.type}] ${url} (${formatBytes(r.transferSize)}, ${Math.round(r.duration)}ms)`);
      });
      if (d.data.renderBlocking.length > DL.renderBlockingLimit) {
        console.log(`     ... and ${d.data.renderBlocking.length - DL.renderBlockingLimit} more`);
      }
    }

    // Main Thread
    subheading(PAGESPEED.categories.mainThread.label);
    printChecks(d.checks.filter(c => c.category === 'mainThread'));

    if (d.data.longTasks.length > 0) {
      console.log('');
      info('Long tasks:');
      d.data.longTasks
        .sort((a, b) => b.duration - a.duration)
        .slice(0, DL.longTaskLimit)
        .forEach(t => {
          console.log(`     • ${Math.round(t.duration)}ms at ${Math.round(t.startTime)}ms`);
        });
      if (d.data.longTasks.length > DL.longTaskLimit) {
        console.log(`     ... and ${d.data.longTasks.length - DL.longTaskLimit} more`);
      }
    }

    // Layout Stability
    subheading(PAGESPEED.categories.layoutStability.label);
    info(`Total CLS: ${d.data.cls} (${d.data.layoutShifts.length} shift events)`);

    if (d.data.shiftSources.length > 0) {
      info('Shifting elements:');
      d.data.shiftSources.slice(0, DL.shiftSourceLimit).forEach(s => {
        console.log(`     • ${s.selector}`);
      });
      if (d.data.shiftSources.length > DL.shiftSourceLimit) {
        console.log(`     ... and ${d.data.shiftSources.length - DL.shiftSourceLimit} more`);
      }
    }

    // Resource Efficiency
    subheading(PAGESPEED.categories.resourceEfficiency.label);
    printChecks(d.checks.filter(c => c.category === 'resourceEfficiency'));

    // Resource breakdown by type
    const byType = {};
    d.data.resources.forEach(r => {
      const type = r.initiatorType || 'other';
      if (!byType[type]) byType[type] = { count: 0, size: 0 };
      byType[type].count++;
      byType[type].size += r.transferSize;
    });
    const typeEntries = Object.entries(byType).sort((a, b) => b[1].size - a[1].size);
    info(`Resources: ${d.data.resources.length} total (${d.data.totalPageWeight} KB)`);
    typeEntries.forEach(([type, { count, size }]) => {
      console.log(`     • ${type}: ${count} files (${formatBytes(size)})`);
    });

    // Unused JS bundles
    if (d.data.coverage && d.data.coverage.jsBundles.length > 0) {
      console.log('');
      info('Unused JS bundles:');
      d.data.coverage.jsBundles.slice(0, DL.unusedBundleLimit).forEach(b => {
        const url = truncateUrl(b.url, DL.urlTruncate);
        console.log(`     • ${b.unusedPercent}% unused — ${url} (${formatBytes(b.totalBytes)})`);
      });
      if (d.data.coverage.jsBundles.length > DL.unusedBundleLimit) {
        console.log(`     ... and ${d.data.coverage.jsBundles.length - DL.unusedBundleLimit} more`);
      }

      info(`CSS coverage: ${d.data.coverage.css.unusedPercent}% unused rules (${d.data.coverage.css.usedRules}/${d.data.coverage.css.totalRules} used)`);
    }

    // Critical Path (PSI only)
    if (d.data.psi) {
      subheading(PAGESPEED.categories.criticalPath.label);
      printChecks(d.checks.filter(c => c.category === 'criticalPath'));

      if (d.data.psi.hasFieldData) {
        info('CrUX field data (p75):');
        const fd = d.data.psi.fieldData;
        if (fd.lcp) console.log(`     • LCP: ${fd.lcp}ms`);
        if (fd.cls) console.log(`     • CLS: ${fd.cls}`);
        if (fd.inp) console.log(`     • INP: ${fd.inp}ms`);
        if (fd.ttfb) console.log(`     • TTFB: ${fd.ttfb}ms`);
      }

      if (d.data.psi.diagnostics?.mainThreadBreakdown) {
        console.log('');
        info('Main thread breakdown:');
        d.data.psi.diagnostics.mainThreadBreakdown.forEach(item => {
          console.log(`     • ${item.group}: ${item.duration}ms`);
        });
      }

      if (d.data.psi.diagnostics?.bootupTime) {
        console.log('');
        info('Script boot-up time (top 5):');
        d.data.psi.diagnostics.bootupTime.forEach(item => {
          console.log(`     • ${truncateUrl(item.url, DL.urlTruncate)}: ${item.total}ms (scripting: ${item.scripting}ms)`);
        });
      }
    }

    // Per-strategy warnings
    if (d.warnings.length > 0) {
      console.log('');
      for (const w of d.warnings) warn(w);
    }
  }

  // ── Manual Checks ────────────────────────────────────────
  if (result.manualChecks.length > 0) {
    console.log('');
    for (const mc of result.manualChecks) warn(mc);
  }

  // Save report
  if (args.save) {
    const summary = buildSummary('pagespeed', args.url, result.data);
    const filepath = saveReport('pagespeed', summary);
    console.log(`\n  📄 Full report saved: ${filepath}`);
  }

  // Summary
  heading('PageSpeed Diagnostics Summary');
  if (result.passed) {
    console.log('  ✅ All PageSpeed diagnostics checks passed');
  } else {
    console.log(`  ❌ ${result.failCount} check(s) failed — see details above`);
  }

  process.exit(result.passed ? 0 : 1);
}

run().catch(err => {
  console.error('\n❌ PageSpeed diagnostics audit failed:', err.message);
  process.exit(2);
});
