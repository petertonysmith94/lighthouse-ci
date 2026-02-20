#!/usr/bin/env node

/**
 * Link Checker
 * ────────────
 * Crawls a site starting from a given URL, discovers all internal links,
 * and validates them. Reports broken links (4xx/5xx), lists external links
 * for manual review, and optionally validates external links too.
 *
 * Usage:
 *   node scripts/link-checker.js http://localhost:3000/
 *   node scripts/link-checker.js https://preview-url.vercel.app -p mypass
 *   node scripts/link-checker.js http://localhost:3000/ --max-pages 10
 *   node scripts/link-checker.js http://localhost:3000/ --check-external
 */

import { chromium } from 'playwright';
import ora from 'ora';
import { createCLI, resolveArgs } from '../lib/cli.js';
import { LINK_CHECKER } from '../lib/config.js';
import { vercelAuth } from '../lib/vercel-auth.js';
import {
  heading, subheading, pass, fail, warn, info,
  saveReport, buildSummary
} from '../lib/report.js';
import { runLinkChecker } from '../lib/runners/link-checker.js';

// ── CLI Setup ──────────────────────────────────────────────
const program = createCLI(
  'link-checker',
  'Crawl a site and validate internal/external links'
);

program
  .option('--max-pages <n>', 'Max pages to crawl', String(LINK_CHECKER.maxPages))
  .option('--check-external', 'Also validate external links')
  .option('--timeout <ms>', 'Navigation timeout per page in ms', String(LINK_CHECKER.navigationTimeout))
  .parse(process.argv);

const args = resolveArgs(program);

// ── Main ───────────────────────────────────────────────────
async function run() {
  heading(`Link Checker: ${args.url}`);

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

  const spinner = ora('Crawling site...').start();

  const result = await runLinkChecker({
    url: args.url,
    authCookieObjects,
    options: {
      maxPages: parseInt(args.maxPages),
      checkExternal: args.checkExternal,
      timeout: parseInt(args.timeout),
    },
  });

  spinner.stop();

  const { stats, brokenLinks, externalLinks, externalResults } = result.data;

  // ── Crawl Summary ──────────────────────────────────────
  subheading('Crawl Summary');
  info(`Pages crawled: ${stats.pagesCrawled}`);
  info(`External links found: ${stats.externalLinksFound}`);

  // ── Broken Links ───────────────────────────────────────
  if (brokenLinks.length > 0) {
    subheading('Broken Links');
    const limit = LINK_CHECKER.display.brokenLinkLimit;
    for (const link of brokenLinks.slice(0, limit)) {
      const detail = link.error
        ? `${truncate(link.url)} — ${link.error}`
        : `${truncate(link.url)} (status: ${link.status})`;
      fail(`${link.external ? '[external] ' : ''}${detail}`);
    }
    if (brokenLinks.length > limit) {
      info(`... and ${brokenLinks.length - limit} more broken links`);
    }
  } else {
    subheading('Links');
    pass(`All ${stats.pagesCrawled} crawled pages returned valid responses`);
  }

  // ── External Links ─────────────────────────────────────
  if (args.checkExternal && externalResults.length > 0) {
    subheading('External Link Validation');
    const brokenExt = externalResults.filter(r => !r.passed);
    const validExt = externalResults.filter(r => r.passed);
    if (validExt.length > 0) {
      pass(`${validExt.length} external link(s) are valid`);
    }
    for (const link of brokenExt) {
      const detail = link.error
        ? `${truncate(link.url)} — ${link.error}`
        : `${truncate(link.url)} (status: ${link.status})`;
      fail(detail);
    }
  } else if (externalLinks.length > 0) {
    subheading('External Links (manual check recommended)');
    const limit = LINK_CHECKER.display.externalLinkLimit;
    for (const url of externalLinks.slice(0, limit)) {
      console.log(`     → ${truncate(url)}`);
    }
    if (externalLinks.length > limit) {
      info(`... and ${externalLinks.length - limit} more external links`);
    }
  }

  // ── Warnings ───────────────────────────────────────────
  for (const w of result.warnings) warn(w);

  // ── Save Report ────────────────────────────────────────
  if (args.save) {
    const reportData = buildSummary('link-checker', args.url, result.data);
    const filepath = saveReport('link-checker', reportData);
    console.log(`\n  📄 Report saved: ${filepath}`);
  }

  // ── Summary ────────────────────────────────────────────
  heading('Link Check Summary');
  if (result.passed) {
    pass('All links are valid');
  } else {
    fail(`${result.failCount} broken link(s) found`);
  }

  process.exit(result.passed ? 0 : 1);
}

function truncate(str) {
  const max = LINK_CHECKER.display.urlTruncate;
  return str.length > max ? str.slice(0, max - 1) + '…' : str;
}

run().catch(err => {
  console.error('\n❌ Link check failed:', err.message);
  process.exit(2);
});
