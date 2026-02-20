#!/usr/bin/env node

/**
 * Site Audit
 * ──────────
 * Multi-page audit that discovers pages via sitemap and runs
 * tiered audits across the entire site.
 *
 * Cheap audits (accessibility, SEO) run on ALL pages.
 * Expensive audits (lighthouse, pagespeed, breakpoints) run on a sample.
 * Site-wide audits (redirects, link-checker) run once on the base URL.
 *
 * Usage:
 *   node scripts/site-audit.js https://preview-url.vercel.app
 *   node scripts/site-audit.js https://preview-url.vercel.app --password mypass
 *   node scripts/site-audit.js https://preview-url.vercel.app --ci --ci-summary summary.md --ci-comment comment.md
 */

import { writeFileSync } from 'fs';
import { createCLI, resolveArgs } from '../lib/cli.js';
import { discoverPages } from '../lib/sitemap.js';
import { runSiteAudit } from '../lib/site-audit.js';
import { generateCIReport } from '../lib/ci-report.js';
import { chromium } from 'playwright';
import { vercelAuth, cookiesToString } from '../lib/vercel-auth.js';
import {
  heading, subheading, pass, fail, warn, info,
  saveReport, buildSummary
} from '../lib/report.js';

// ── CLI Setup ──────────────────────────────────────────────
const program = createCLI(
  'site-audit',
  'Multi-page site audit — discovers pages via sitemap and runs tiered audits'
);

program
  .option('--sitemap <path>', 'Override sitemap path', '/sitemap.xml')
  .option('--max-pages <n>', 'Max pages to audit', '100')
  .option('--heavy-sample <n>', 'Pages for expensive audits', '3')
  .option('--skip <sections>', 'Comma-separated sections to skip (accessibility,seo,lighthouse,pagespeed,breakpoints,redirects,links)')
  .option('--browsers <browsers>', 'Browsers for breakpoint tests (comma-separated)', 'chromium,webkit')
  .option('--psi-api-key <key>', 'Google PSI API key for PageSpeed diagnostics CrUX data')
  .option('--redirects <file>', 'JSON file with redirect map [{from, to}]')
  .option('--ci', 'CI mode: write Markdown files instead of pretty-printing')
  .option('--ci-summary <file>', 'Write job summary Markdown to file')
  .option('--ci-comment <file>', 'Write PR comment Markdown to file')
  .parse(process.argv);

const args = resolveArgs(program);
const skip = (args.skip || '').split(',').map(s => s.trim()).filter(Boolean);

// ── Main ───────────────────────────────────────────────────
async function run() {
  const startTime = Date.now();

  heading(`Site Audit: ${args.url}`);
  console.log('');

  // ── Phase 1: Authenticate ─────────────────────────────────
  let authCookieObjects = null;

  if (args.password) {
    info('Authenticating with Vercel preview...');
    const authBrowser = await chromium.launch({ headless: true });
    const auth = await vercelAuth(authBrowser, args.url, args.password);
    authCookieObjects = auth.cookies;
    await auth.context.close();
    await authBrowser.close();
    pass('Authenticated');
  }

  // ── Phase 2: Discover Pages ───────────────────────────────
  heading('Page Discovery');
  info(`Fetching sitemap from ${args.sitemap}...`);

  const discovery = await discoverPages({
    baseUrl: args.url,
    authCookieObjects,
    options: {
      sitemapPath: args.sitemap,
      maxPages: parseInt(args.maxPages, 10),
    },
  });

  info(`Source: ${discovery.source}`);
  info(`Pages discovered: ${discovery.urls.length}`);

  for (const w of discovery.warnings) warn(w);

  if (discovery.urls.length === 0) {
    fail('No pages discovered — cannot continue');
    process.exit(2);
  }

  // Show discovered pages
  subheading('Pages');
  for (const url of discovery.urls.slice(0, 20)) {
    try {
      console.log(`  • ${new URL(url).pathname}`);
    } catch {
      console.log(`  • ${url}`);
    }
  }
  if (discovery.urls.length > 20) {
    console.log(`  ... and ${discovery.urls.length - 20} more`);
  }

  // ── Phase 3: Run Site Audit ───────────────────────────────
  heading('Running Audits');
  console.log('');

  const results = await runSiteAudit({
    baseUrl: args.url,
    urls: discovery.urls,
    password: args.password,
    options: {
      skip,
      heavySample: parseInt(args.heavySample, 10),
      browsers: args.browsers.split(',').map(b => b.trim()),
      psiApiKey: args.psiApiKey,
      redirectsFile: args.redirects,
      onSectionStart: (section) => {
        heading(`Audit: ${section}`);
      },
      onPageStart: (url, audit) => {
        try {
          info(`${audit}: ${new URL(url).pathname}`);
        } catch {
          info(`${audit}: ${url}`);
        }
      },
      onPageComplete: (url, audit, result) => {
        if (result.failCount === 0) {
          pass(`${audit}: passed`);
        } else {
          fail(`${audit}: ${result.failCount} issue(s)`);
        }
      },
    },
  });

  // ── Phase 4: Report ───────────────────────────────────────
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const { summary } = results;

  // Save JSON report
  if (args.save) {
    const reportData = buildSummary('site-audit', args.url, {
      discovery: { source: discovery.source, pageCount: discovery.urls.length },
      summary: results.summary,
    });
    const filepath = saveReport('site-audit', reportData);
    info(`Report saved: ${filepath}`);
  }

  // CI mode: write Markdown files
  if (args.ci) {
    const ciReport = generateCIReport({
      results,
      previewUrl: args.url,
      commitSha: process.env.GITHUB_SHA,
      runUrl: process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
        ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
        : undefined,
    });

    if (args.ciSummary) {
      writeFileSync(args.ciSummary, ciReport.summary);
      info(`Job summary written: ${args.ciSummary}`);
    }

    if (args.ciComment) {
      writeFileSync(args.ciComment, ciReport.comment);
      info(`PR comment written: ${args.ciComment}`);
    }
  }

  // Console summary
  heading(`Site Audit Complete (${elapsed}s)`);
  console.log('');

  subheading('Summary');
  info(`Pages audited: ${summary.totalPages}`);
  info(`Sampled for heavy audits: ${summary.sampledPages}`);
  console.log('');

  for (const [audit, pagesRun] of Object.entries(summary.auditsRun)) {
    const fails = summary.failsByAudit[audit] || 0;
    if (fails === 0) {
      pass(`${audit}: ${pagesRun} page(s) — all passed`);
    } else {
      fail(`${audit}: ${fails} issue(s) across ${pagesRun} page(s)`);
    }
  }

  console.log('');

  if (summary.worstPages.length > 0) {
    const pagesWithIssues = summary.worstPages.filter(p => p.fails > 0);
    if (pagesWithIssues.length > 0) {
      subheading('Worst Pages');
      for (const { url, fails } of pagesWithIssues) {
        try {
          fail(`${new URL(url).pathname} — ${fails} issue(s)`);
        } catch {
          fail(`${url} — ${fails} issue(s)`);
        }
      }
      console.log('');
    }
  }

  if (summary.totalFails === 0) {
    pass('All checks passed across every page');
  } else {
    fail(`${summary.totalFails} total issue(s) found — review details above`);
  }

  process.exit(summary.totalFails > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('\nSite audit failed:', err.message);
  process.exit(2);
});
