#!/usr/bin/env node

/**
 * SEO Audit
 * ─────────
 * Checks a page for SEO requirements from the Plasma spec (Section 2.3 + 7.4).
 * Uses Playwright to render the page and inspect the DOM directly.
 *
 * Covers PR checklist section:
 *   §4 — SEO
 *     - Page is server-side rendered (not client-only)
 *     - Unique <title>, <meta description>, canonical URL
 *     - Open Graph + Twitter Card meta tags
 *     - JSON-LD structured data (org, product, FAQ, breadcrumb)
 *     - Semantic HTML5 elements
 *     - All images have alt text
 *     - Lighthouse SEO score > 95 (covered by lighthouse-audit.js)
 *
 * Usage:
 *   node scripts/seo-audit.js https://preview-url.vercel.app
 *   node scripts/seo-audit.js https://preview-url.vercel.app --password mypass
 *   node scripts/seo-audit.js https://preview-url.vercel.app --check-ssr
 */

import { chromium } from 'playwright';
import { createCLI, resolveArgs } from '../lib/cli.js';
import { SEO } from '../lib/config.js';
import { vercelAuth } from '../lib/vercel-auth.js';
import {
  heading, subheading, pass, fail, warn, info,
  printChecks, saveReport, buildSummary
} from '../lib/report.js';
import { runSeoAudit } from '../lib/runners/seo.js';

// ── CLI Setup ──────────────────────────────────────────────
const program = createCLI(
  'seo-audit',
  'Check page for SEO requirements from Plasma spec (meta tags, OG, JSON-LD, semantic HTML)'
);

program
  .option('--check-ssr', 'Verify page is server-side rendered by comparing JS-off content')
  .parse(process.argv);

const args = resolveArgs(program);

// ── Main ───────────────────────────────────────────────────
async function run() {
  heading(`SEO Audit: ${args.url}`);

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

  const result = await runSeoAudit({
    url: args.url,
    authCookieObjects,
    options: { checkSsr: args.checkSsr },
  });

  // Print results by section
  subheading('Meta Tags');
  const metaChecks = result.checks.filter(c => ['Title tag', 'Meta description', 'Canonical URL'].includes(c.label));
  printChecks(metaChecks);
  for (const w of result.warnings.filter(w => w.includes('chars'))) warn(w);

  subheading('Open Graph');
  printChecks(result.checks.filter(c => c.label === 'Open Graph tags'));
  const d = result.data;
  if (d.openGraph) {
    Object.entries(d.openGraph).forEach(([key, value]) => {
      if (value) info(`  ${key}: ${value.slice(0, SEO.display.ogValueTruncate)}`);
    });
  }

  subheading('Twitter Card');
  printChecks(result.checks.filter(c => c.label === 'Twitter Card tags'));

  subheading('Structured Data (JSON-LD)');
  printChecks(result.checks.filter(c => c.label === 'JSON-LD' || c.label === 'JSON-LD validity'));
  if (d.jsonLdTypes) {
    info(`Types: ${d.jsonLdTypes.join(', ')}`);
    for (const t of SEO.expectedJsonLdTypes) {
      if (d.jsonLdExpected?.[t]) {
        pass(`  ${t} schema present`);
      } else {
        info(`  ${t} schema not found (check if applicable to this page)`);
      }
    }
  }

  subheading('Semantic HTML');
  printChecks(result.checks.filter(c => c.label === 'Semantic HTML' || c.label === 'H1 tag' || c.label === 'Heading hierarchy'));
  for (const w of result.warnings.filter(w => w.includes('semantic') || w.includes('<h1>') || w.includes('Heading hierarchy'))) warn(w);

  subheading('Image Alt Text');
  printChecks(result.checks.filter(c => c.label === 'Image alt text'));
  if (d.images.missingElements?.length > 0) {
    d.images.missingElements.slice(0, SEO.display.missingAltLimit).forEach(img => {
      console.log(`     • ${img.src}`);
    });
    if (d.images.missingElements.length > SEO.display.missingAltLimit) {
      console.log(`     ... and ${d.images.missingElements.length - SEO.display.missingAltLimit} more`);
    }
  }

  if (args.checkSsr) {
    subheading('Server-Side Rendering Check');
    printChecks(result.checks.filter(c => c.label === 'SSR'));
    if (d.ssr && !d.ssr.hasContent) {
      info(`Raw HTML length without JS: ${d.ssr.htmlLength} chars`);
    }
  }

  // Save report
  if (args.save) {
    const reportData = buildSummary('seo', args.url, d);
    const filepath = saveReport('seo', reportData);
    console.log(`\n  📄 Full report saved: ${filepath}`);
  }

  // Summary
  heading('SEO Audit Summary');
  info(`Passed: ${result.checks.filter(c => c.passed).length} | Failed: ${result.failCount}`);

  if (result.passed) {
    pass('All SEO checks passed');
  } else {
    fail(`${result.failCount} SEO issue(s) found — see details above`);
  }

  for (const reminder of result.manualChecks) warn(reminder);

  process.exit(result.passed ? 0 : 1);
}

run().catch(err => {
  console.error('\n❌ SEO audit failed:', err.message);
  process.exit(2);
});
