#!/usr/bin/env node

/**
 * Redirect Checker
 * ────────────────
 * Validates that plasma.to URLs correctly 301 redirect to plasma.org equivalents.
 * Also checks for broken internal links and CTA destinations.
 *
 * Covers PR checklist section:
 *   §9 — Redirects & Routing
 *     - 301 redirects from plasma.to → plasma.org working
 *     - No broken internal links
 *     - External links open correctly
 *     - Custom 404 page renders
 *
 * Usage:
 *   node scripts/redirect-checker.js https://plasma.org --check-404
 *   node scripts/redirect-checker.js https://preview-url.vercel.app --password mypass --redirects redirects.json
 */

import { chromium } from 'playwright';
import { createCLI, resolveArgs } from '../lib/cli.js';
import { REDIRECTS } from '../lib/config.js';
import { vercelAuth } from '../lib/vercel-auth.js';
import {
  heading, subheading, pass, fail, warn, info,
  saveReport, buildSummary
} from '../lib/report.js';
import { runRedirectChecker } from '../lib/runners/redirects.js';

// ── CLI Setup ──────────────────────────────────────────────
const program = createCLI(
  'redirect-checker',
  'Validate redirects, internal links, and 404 page'
);

program
  .option('--redirects <file>', 'JSON file with redirect map [{from, to}]')
  .option('--check-404', 'Verify custom 404 page renders')
  .option('--check-links', 'Crawl page and check all internal links')
  .option('--timeout <ms>', 'Navigation timeout in ms', String(REDIRECTS.navigationTimeout))
  .parse(process.argv);

const args = resolveArgs(program);

// ── Main ───────────────────────────────────────────────────
async function run() {
  heading(`Redirect & Link Checker: ${args.url}`);

  // Authenticate if needed
  let authCookieObjects = null;
  if (args.password) {
    info('Authenticating with Vercel preview...');
    const browser = await chromium.launch({ headless: true });
    const auth = await vercelAuth(browser, args.url, args.password);
    authCookieObjects = auth.cookies;
    await auth.context.close();
    await browser.close();
  }

  const result = await runRedirectChecker({
    url: args.url,
    authCookieObjects,
    options: {
      redirectsFile: args.redirects,
      check404: args.check404,
      checkLinks: args.checkLinks,
      timeout: parseInt(args.timeout),
    },
  });

  // Print redirect results
  if (args.redirects) {
    subheading('301 Redirect Validation (plasma.to → plasma.org)');
    const redirectChecks = result.checks.filter(c => c.label.startsWith('Redirect '));
    for (const c of redirectChecks) {
      if (c.passed) pass(c.message);
      else fail(c.message);
    }
  }

  // Print link results
  if (args.checkLinks) {
    subheading('Internal Link Check');
    const { links, externalLinks } = result.data;
    const totalInternal = links.length;
    const brokenLinks = links.filter(l => !l.passed);

    info(`Found ${totalInternal} unique internal links, ${externalLinks.length} external`);

    // Print broken links
    for (const c of result.checks.filter(c => c.label.startsWith('Link '))) {
      fail(c.message);
    }

    // Print overall internal link check
    const linkSummary = result.checks.find(c => c.label === 'Internal links');
    if (linkSummary) pass(linkSummary.message);

    // External links
    if (externalLinks.length > 0) {
      info('External links found (manual check recommended):');
      externalLinks.slice(0, REDIRECTS.display.externalLinkLimit).forEach(url => {
        console.log(`     → ${url}`);
      });
      if (externalLinks.length > REDIRECTS.display.externalLinkLimit) {
        console.log(`     ... and ${externalLinks.length - REDIRECTS.display.externalLinkLimit} more`);
      }
    }
  }

  // Print 404 results
  if (args.check404) {
    subheading('Custom 404 Page');
    const checks404 = result.checks.filter(c => c.label.includes('404'));
    for (const c of checks404) {
      if (c.passed) pass(c.message);
      else fail(c.message);
    }
  }

  for (const w of result.warnings) warn(w);

  // Save report
  if (args.save) {
    const reportData = buildSummary('redirects', args.url, result.data);
    const filepath = saveReport('redirects', reportData);
    console.log(`\n  📄 Report saved: ${filepath}`);
  }

  heading('Redirect & Link Check Summary');
  if (result.passed) {
    pass('All checks passed');
  } else {
    fail(`${result.failCount} issue(s) found`);
  }

  process.exit(result.passed ? 0 : 1);
}

run().catch(err => {
  console.error('\n❌ Redirect check failed:', err.message);
  process.exit(2);
});
