#!/usr/bin/env node

/**
 * Breakpoint Test
 * ───────────────
 * Uses Playwright to capture screenshots at all 4 spec breakpoints
 * across Chromium, WebKit, and Firefox. Checks for horizontal overflow.
 *
 * Covers PR checklist section:
 *   §2 — Responsive & Cross-Browser
 *     - Renders correctly at Desktop (1440px+), Laptop (1024px), Tablet (768px), Mobile (375px)
 *     - No horizontal overflow or broken layouts
 *     - Chrome + Safari + Firefox/Edge
 *     - iOS Safari + Chrome Android consideration
 *
 * Usage:
 *   node scripts/breakpoint-test.js https://preview-url.vercel.app
 *   node scripts/breakpoint-test.js https://preview-url.vercel.app --password mypass
 *   node scripts/breakpoint-test.js https://preview-url.vercel.app --browsers chromium,webkit
 *   node scripts/breakpoint-test.js https://preview-url.vercel.app --full-page
 */

import { chromium } from 'playwright';
import { createCLI, resolveArgs } from '../lib/cli.js';
import { BREAKPOINTS } from '../lib/config.js';
import { vercelAuth } from '../lib/vercel-auth.js';
import {
  heading, subheading, pass, fail, warn, info,
  saveReport, buildSummary
} from '../lib/report.js';
import { runBreakpointTest } from '../lib/runners/breakpoints.js';

// ── CLI Setup ──────────────────────────────────────────────
const program = createCLI(
  'breakpoint-test',
  'Capture screenshots at all breakpoints and check for layout issues'
);

program
  .option('--browsers <browsers>', 'Browsers to test (comma-separated: chromium,webkit,firefox)', 'chromium,webkit')
  .option('--full-page', 'Capture full-page screenshots (not just viewport)')
  .option('--check-overflow', 'Check for horizontal overflow at each breakpoint', true)
  .option('--no-check-overflow', 'Skip horizontal overflow check')
  .parse(process.argv);

const args = resolveArgs(program);

// ── Main ───────────────────────────────────────────────────
async function run() {
  heading(`Breakpoint Test: ${args.url}`);

  const browsers = args.browsers.split(',').map(b => b.trim());

  // Authenticate if needed
  let authCookieObjects = null;
  if (args.password) {
    info('Authenticating with Vercel preview...');
    const authBrowser = await chromium.launch({ headless: true });
    const auth = await vercelAuth(authBrowser, args.url, args.password);
    authCookieObjects = auth.cookies;
    await auth.context.close();
    await authBrowser.close();
  }

  info(`Browsers: ${browsers.join(', ')}`);
  info(`Breakpoints: ${BREAKPOINTS.map(b => `${b.name} (${b.width}px)`).join(', ')}`);

  const result = await runBreakpointTest({
    url: args.url,
    authCookieObjects,
    options: {
      browsers,
      fullPage: args.fullPage,
      checkOverflow: args.checkOverflow,
    },
  });

  info(`Screenshots: ${result.data.screenshotDir}`);

  // Print per-browser/breakpoint results
  let currentBrowser = '';
  for (const check of result.checks) {
    // Detect browser change from results structure
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

  for (const w of result.warnings) warn(w);

  // Save report
  if (args.save) {
    const summary = buildSummary('breakpoints', args.url, result.data.results);
    const filepath = saveReport('breakpoints', summary);
    console.log(`\n  📄 Report saved: ${filepath}`);
  }

  // Summary
  heading('Breakpoint Test Summary');
  info(`Screenshots saved to: ${result.data.screenshotDir}`);

  if (result.passed) {
    pass('No horizontal overflow detected at any breakpoint');
  } else {
    fail(`${result.failCount} overflow issue(s) found — see details above`);
  }

  for (const mc of result.manualChecks) warn(mc);

  process.exit(result.passed ? 0 : 1);
}

run().catch(err => {
  console.error('\n❌ Breakpoint test failed:', err.message);
  process.exit(2);
});
