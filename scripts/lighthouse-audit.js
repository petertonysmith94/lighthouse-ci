#!/usr/bin/env node

/**
 * Lighthouse Audit
 * ────────────────
 * Runs Google Lighthouse against a URL and checks results against
 * the Plasma spec thresholds (Section 2.2 + 7.2 + 7.4).
 *
 * Covers PR checklist sections:
 *   §3 — Performance (LCP, FID, CLS, TTFB, PageSpeed scores)
 *   §4 — SEO (Lighthouse SEO score > 95)
 *
 * Usage:
 *   node scripts/lighthouse-audit.js https://preview-url.vercel.app
 *   node scripts/lighthouse-audit.js https://preview-url.vercel.app --password mypass
 *   node scripts/lighthouse-audit.js https://preview-url.vercel.app --strategy mobile
 *   node scripts/lighthouse-audit.js https://preview-url.vercel.app --strategy both
 */

import { chromium } from 'playwright';
import { createCLI, resolveArgs } from '../lib/cli.js';
import { LIGHTHOUSE } from '../lib/config.js';
import { vercelAuth, cookiesToString } from '../lib/vercel-auth.js';
import {
  heading, subheading, info, warn,
  printChecks, saveReport, buildSummary
} from '../lib/report.js';
import { runLighthouseAudit } from '../lib/runners/lighthouse.js';

// ── CLI Setup ──────────────────────────────────────────────
const program = createCLI(
  'lighthouse-audit',
  'Run Lighthouse performance + SEO audit against Plasma spec thresholds'
);

program
  .option('-s, --strategy <strategy>', 'Test strategy: mobile, desktop, or both', 'both')
  .option('--throttle-3g', 'Run additional 3G throttled test (Namibia Test)')
  .parse(process.argv);

const args = resolveArgs(program);

// ── Main ───────────────────────────────────────────────────
async function run() {
  heading(`Lighthouse Audit: ${args.url}`);

  // Step 1: Handle Vercel auth if needed — get cookies
  let authCookies = '';
  if (args.password) {
    info('Authenticating with Vercel preview...');
    const browser = await chromium.launch({ headless: true });
    const { cookies, context } = await vercelAuth(browser, args.url, args.password);
    authCookies = cookiesToString(cookies);
    await context.close();
    await browser.close();
  }

  const result = await runLighthouseAudit({
    url: args.url,
    authCookies,
    options: {
      strategy: args.strategy,
      throttle3g: args.throttle3g,
    },
  });

  // Print per-strategy results
  for (const [strategy, data] of Object.entries(result.data)) {
    if (strategy === '3g') {
      subheading('3G Throttled Test ("Namibia Test")');
      printChecks(data.checks);
      continue;
    }

    subheading(`Strategy: ${strategy.toUpperCase()}`);
    info(`Performance: ${data.scores.performance} | SEO: ${data.scores.seo} | Accessibility: ${data.scores.accessibility} | Best Practices: ${data.scores.bestPractices}`);
    console.log('');
    printChecks(data.checks);

    // Flag failed audits
    if (data.failedAudits.length > 0) {
      console.log('');
      warn(`${data.failedAudits.length} audits scored below 50%:`);
      data.failedAudits.slice(0, LIGHTHOUSE.display.failedAuditLimit).forEach(a => {
        console.log(`     • ${a.title} (${Math.round(a.score * 100)}%)`);
      });
      if (data.failedAudits.length > LIGHTHOUSE.display.failedAuditLimit) {
        console.log(`     ... and ${data.failedAudits.length - LIGHTHOUSE.display.failedAuditLimit} more (see full report)`);
      }
    }
  }

  // Save report
  if (args.save) {
    const summary = buildSummary('lighthouse', args.url, result.data);
    const filepath = saveReport('lighthouse', summary);
    console.log(`\n  📄 Full report saved: ${filepath}`);
  }

  // Summary
  heading('Lighthouse Summary');
  if (result.passed) {
    console.log('  ✅ All Lighthouse checks passed against Plasma spec thresholds');
  } else {
    console.log('  ❌ Some checks failed — see details above');
  }

  process.exit(result.passed ? 0 : 1);
}

run().catch(err => {
  console.error('\n❌ Lighthouse audit failed:', err.message);
  process.exit(2);
});
