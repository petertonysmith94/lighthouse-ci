#!/usr/bin/env node

/**
 * Quick Check
 * ───────────
 * Fast combined audit for every PR review (< 2 minutes).
 * Runs: Lighthouse scores (mobile + desktop) + axe summary + basic SEO meta check.
 *
 * This is the "run on every PR" command. For deeper audits, use the
 * individual scripts or the full-audit command.
 *
 * Usage:
 *   node scripts/quick-check.js https://preview-url.vercel.app
 *   node scripts/quick-check.js https://preview-url.vercel.app --password mypass
 */

import { chromium } from 'playwright';
import { createCLI, resolveArgs } from '../lib/cli.js';
import { LIGHTHOUSE, ACCESSIBILITY } from '../lib/config.js';
import { vercelAuth, cookiesToString } from '../lib/vercel-auth.js';
import {
  heading, subheading, pass, fail, warn, info,
  printChecks, saveReport, buildSummary
} from '../lib/report.js';
import { runLighthouseAudit } from '../lib/runners/lighthouse.js';
import { runAccessibilityAudit } from '../lib/runners/accessibility.js';
import { runSeoAudit } from '../lib/runners/seo.js';

// ── CLI Setup ──────────────────────────────────────────────
const program = createCLI(
  'quick-check',
  'Fast PR review check: Lighthouse scores + accessibility summary + SEO meta tags'
);

program.parse(process.argv);
const args = resolveArgs(program);

// ── Main ───────────────────────────────────────────────────
async function run() {
  const startTime = Date.now();
  heading(`Quick Check: ${args.url}`);

  // Authenticate once with Playwright, share cookies
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
  }

  const results = {};
  let totalFails = 0;

  // ── 1. Lighthouse (mobile) ───────────────────────────────
  subheading('Lighthouse — Mobile');

  const mobileResult = await runLighthouseAudit({
    url: args.url,
    authCookies,
    options: {
      strategy: 'mobile',
      categories: LIGHTHOUSE.quickCategories.mobile,
    },
  });

  const mobileData = mobileResult.data.mobile;
  const mobileChecks = mobileData.checks.filter(c =>
    c.label.includes('PageSpeed') || c.label.includes('SEO')
  );
  printChecks(mobileChecks);
  info(`Accessibility score: ${mobileData.scores.accessibility}/100`);
  totalFails += mobileChecks.filter(c => !c.passed).length;

  results.mobile = mobileData.scores;

  // ── 2. Lighthouse (desktop) ──────────────────────────────
  subheading('Lighthouse — Desktop');

  const desktopResult = await runLighthouseAudit({
    url: args.url,
    authCookies,
    options: {
      strategy: 'desktop',
      categories: LIGHTHOUSE.quickCategories.desktop,
    },
  });

  const desktopData = desktopResult.data.desktop;
  const desktopChecks = desktopData.checks.filter(c =>
    c.label.includes('PageSpeed') || c.label.includes('SEO')
  );
  printChecks(desktopChecks);
  totalFails += desktopChecks.filter(c => !c.passed).length;

  results.desktop = desktopData.scores;

  // ── 3. Axe Quick Scan ────────────────────────────────────
  subheading('Accessibility — axe-core (WCAG 2.1 AA)');

  const a11yResult = await runAccessibilityAudit({
    url: args.url,
    authCookieObjects,
  });

  const { summary } = a11yResult.data;
  if (summary.totalViolations === 0) {
    pass('No accessibility violations');
  } else if (summary.bySeverity.critical > 0 || summary.bySeverity.serious > 0) {
    fail(`${summary.bySeverity.critical} critical + ${summary.bySeverity.serious} serious violation(s)`);
    // Show top issues
    const critSerious = a11yResult.data.violations
      .filter(v => v.impact === 'critical' || v.impact === 'serious');
    critSerious.slice(0, LIGHTHOUSE.display.quickIssueLimit).forEach(v => {
      console.log(`     • [${v.impact}] ${v.help} (${v.nodeCount} elements)`);
    });
    totalFails++;
  } else {
    warn(`${summary.totalViolations} minor/moderate violation(s) — non-blocking`);
  }

  results.accessibility = {
    violations: summary.totalViolations,
    critical: summary.bySeverity.critical,
    serious: summary.bySeverity.serious,
  };

  // ── 4. Quick SEO Meta Check ──────────────────────────────
  subheading('SEO Meta Tags');

  const seoResult = await runSeoAudit({
    url: args.url,
    authCookieObjects,
  });

  // Only show the basic meta tag checks for quick-check
  const metaLabels = ['Title tag', 'Meta description', 'Canonical URL', 'Open Graph tags', 'Twitter Card tags'];
  const metaChecks = seoResult.checks.filter(c => metaLabels.includes(c.label));

  for (const c of metaChecks) {
    if (c.passed) {
      pass(`${c.label}: ✓`);
    } else {
      fail(`${c.label}: missing`);
      totalFails++;
    }
  }

  results.meta = seoResult.data;

  // ── Summary ──────────────────────────────────────────────
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  if (args.save) {
    const reportSummary = buildSummary('quick-check', args.url, results);
    const filepath = saveReport('quick-check', reportSummary);
    console.log(`\n  📄 Report saved: ${filepath}`);
  }

  heading(`Quick Check Complete (${elapsed}s)`);

  if (totalFails === 0) {
    pass('All quick checks passed ✓');
    console.log('\n  For deeper analysis, run individual tools:');
    console.log('    npm run lighthouse -- <url>');
    console.log('    npm run accessibility -- <url>');
    console.log('    npm run breakpoints -- <url>');
    console.log('    npm run seo -- <url>');
  } else {
    fail(`${totalFails} issue(s) found — review before approving PR`);
  }

  process.exit(totalFails > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('\n❌ Quick check failed:', err.message);
  process.exit(2);
});
