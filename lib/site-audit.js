/**
 * Site Audit Orchestrator
 * ───────────────────────
 * Takes a list of URLs and runs the appropriate audits on each
 * using a tiered strategy:
 *
 *   - Cheap audits (accessibility, SEO) → ALL pages
 *   - Expensive audits (lighthouse, pagespeed, breakpoints) → sampled pages
 *   - Site-wide audits (redirects, link-checker) → base URL only
 *
 * Reuses existing runners from lib/runners/ — no changes to runner code.
 */

import { chromium } from 'playwright';
import { vercelAuth, cookiesToString } from './vercel-auth.js';
import { SITE_AUDIT } from './config.js';
import { runAccessibilityAudit } from './runners/accessibility.js';
import { runSeoAudit } from './runners/seo.js';
import { runLighthouseAudit } from './runners/lighthouse.js';
import { runPagespeedAudit } from './runners/pagespeed.js';
import { runBreakpointTest } from './runners/breakpoints.js';
import { runRedirectChecker } from './runners/redirects.js';
import { runLinkChecker } from './runners/link-checker.js';

/**
 * Select pages for expensive audits: always includes homepage,
 * then picks pages with diverse path prefixes.
 */
function selectSampledPages(urls, baseUrl, sampleSize) {
  const homepage = new URL(baseUrl).origin + '/';
  const homepageAlt = new URL(baseUrl).origin;
  const sampled = [];

  // Always include homepage
  const homeUrl = urls.find(u => u === homepage || u === homepageAlt) || urls[0];
  if (homeUrl) sampled.push(homeUrl);

  // Pick pages with diverse top-level path prefixes
  const remaining = urls.filter(u => u !== homeUrl);
  const prefixBuckets = new Map();

  for (const url of remaining) {
    try {
      const path = new URL(url).pathname;
      const prefix = '/' + (path.split('/').filter(Boolean)[0] || '');
      if (!prefixBuckets.has(prefix)) {
        prefixBuckets.set(prefix, []);
      }
      prefixBuckets.get(prefix).push(url);
    } catch {
      continue;
    }
  }

  // Round-robin across prefix buckets
  const bucketIter = [...prefixBuckets.values()].map(arr => ({ arr, idx: 0 }));
  while (sampled.length < sampleSize && bucketIter.some(b => b.idx < b.arr.length)) {
    for (const bucket of bucketIter) {
      if (sampled.length >= sampleSize) break;
      if (bucket.idx < bucket.arr.length) {
        sampled.push(bucket.arr[bucket.idx]);
        bucket.idx++;
      }
    }
  }

  return sampled;
}

/**
 * Run a full site audit across all discovered pages.
 *
 * @param {object} opts
 * @param {string} opts.baseUrl - The site's base URL
 * @param {string[]} opts.urls - All discovered page URLs
 * @param {string} [opts.password] - Vercel preview password
 * @param {object} [opts.options]
 * @param {string[]} [opts.options.skip] - Audit types to skip
 * @param {number} [opts.options.heavySample] - Number of pages for expensive audits
 * @param {string[]} [opts.options.browsers] - Browsers for breakpoint tests
 * @param {string} [opts.options.psiApiKey] - Google PSI API key
 * @param {string} [opts.options.redirectsFile] - Redirect map JSON path
 * @param {Function} [opts.options.onPageStart] - Callback(url, auditName)
 * @param {Function} [opts.options.onPageComplete] - Callback(url, auditName, result)
 * @param {Function} [opts.options.onSectionStart] - Callback(sectionName)
 * @returns {Promise<SiteAuditResult>}
 */
export async function runSiteAudit({ baseUrl, urls, password, options = {} }) {
  const skip = new Set(options.skip || []);
  const heavySample = options.heavySample || SITE_AUDIT.heavyAuditSampleSize;
  const onPageStart = options.onPageStart || (() => {});
  const onPageComplete = options.onPageComplete || (() => {});
  const onSectionStart = options.onSectionStart || (() => {});

  // ── Authenticate once ─────────────────────────────────────
  let authCookies = '';
  let authCookieObjects = null;

  if (password) {
    const authBrowser = await chromium.launch({ headless: true });
    const auth = await vercelAuth(authBrowser, baseUrl, password);
    authCookies = cookiesToString(auth.cookies);
    authCookieObjects = auth.cookies;
    await auth.context.close();
    await authBrowser.close();
  }

  const sampledPages = selectSampledPages(urls, baseUrl, heavySample);
  const results = {
    pages: {},
    siteWide: {},
    sampled: {},
    summary: {
      totalPages: urls.length,
      sampledPages: sampledPages.length,
      auditsRun: {},
      failsByAudit: {},
      totalFails: 0,
    },
  };

  // ═══════════════════════════════════════════════════════════
  // SITE-WIDE AUDITS (redirects, link-checker) — base URL only
  // ═══════════════════════════════════════════════════════════

  if (!skip.has('redirects') && SITE_AUDIT.siteWideAudits.includes('redirects')) {
    onSectionStart('redirects');
    onPageStart(baseUrl, 'redirects');

    const result = await runRedirectChecker({
      url: baseUrl,
      authCookieObjects,
      options: {
        redirectsFile: options.redirectsFile,
        check404: true,
        checkLinks: true,
      },
    });

    results.siteWide.redirects = result;
    results.summary.auditsRun.redirects = 1;
    results.summary.failsByAudit.redirects = result.failCount;
    results.summary.totalFails += result.failCount;
    onPageComplete(baseUrl, 'redirects', result);
  }

  if (!skip.has('links') && SITE_AUDIT.siteWideAudits.includes('links')) {
    onSectionStart('links');
    onPageStart(baseUrl, 'links');

    const result = await runLinkChecker({
      url: baseUrl,
      authCookieObjects,
    });

    results.siteWide.links = result;
    results.summary.auditsRun.links = 1;
    results.summary.failsByAudit.links = result.failCount;
    results.summary.totalFails += result.failCount;
    onPageComplete(baseUrl, 'links', result);
  }

  // ═══════════════════════════════════════════════════════════
  // PER-PAGE AUDITS (accessibility, SEO) — ALL pages
  // ═══════════════════════════════════════════════════════════

  for (const auditName of SITE_AUDIT.perPageAudits) {
    if (skip.has(auditName)) continue;

    onSectionStart(auditName);
    let auditFails = 0;

    for (const pageUrl of urls) {
      onPageStart(pageUrl, auditName);

      let result;
      try {
        if (auditName === 'accessibility') {
          result = await runAccessibilityAudit({
            url: pageUrl,
            authCookieObjects,
          });
        } else if (auditName === 'seo') {
          result = await runSeoAudit({
            url: pageUrl,
            authCookieObjects,
            options: { checkSsr: pageUrl === urls[0] },
          });
        }
      } catch (err) {
        result = {
          passed: false,
          failCount: 1,
          data: { error: err.message },
          checks: [{ label: auditName, passed: false, message: `Error: ${err.message}` }],
          warnings: [],
          manualChecks: [],
        };
      }

      if (!results.pages[pageUrl]) {
        results.pages[pageUrl] = {};
      }
      results.pages[pageUrl][auditName] = result;
      auditFails += result.failCount;

      onPageComplete(pageUrl, auditName, result);
    }

    results.summary.auditsRun[auditName] = urls.length;
    results.summary.failsByAudit[auditName] = auditFails;
    results.summary.totalFails += auditFails;
  }

  // ═══════════════════════════════════════════════════════════
  // SAMPLED AUDITS (lighthouse, pagespeed, breakpoints) — sampled pages
  // ═══════════════════════════════════════════════════════════

  for (const auditName of SITE_AUDIT.sampledAudits) {
    if (skip.has(auditName)) continue;

    onSectionStart(auditName);
    let auditFails = 0;

    for (const pageUrl of sampledPages) {
      onPageStart(pageUrl, auditName);

      let result;
      try {
        if (auditName === 'lighthouse') {
          result = await runLighthouseAudit({
            url: pageUrl,
            authCookies,
            options: { strategy: 'both', throttle3g: true },
          });
        } else if (auditName === 'pagespeed') {
          result = await runPagespeedAudit({
            url: pageUrl,
            authCookieObjects,
            options: {
              detailed: true,
              apiKey: options.psiApiKey || null,
              strategy: 'both',
            },
          });
        } else if (auditName === 'breakpoints') {
          result = await runBreakpointTest({
            url: pageUrl,
            authCookieObjects,
            options: {
              browsers: options.browsers || ['chromium', 'webkit'],
            },
          });
        }
      } catch (err) {
        result = {
          passed: false,
          failCount: 1,
          data: { error: err.message },
          checks: [{ label: auditName, passed: false, message: `Error: ${err.message}` }],
          warnings: [],
          manualChecks: [],
        };
      }

      if (!results.sampled[pageUrl]) {
        results.sampled[pageUrl] = {};
      }
      results.sampled[pageUrl][auditName] = result;
      auditFails += result.failCount;

      onPageComplete(pageUrl, auditName, result);
    }

    results.summary.auditsRun[auditName] = sampledPages.length;
    results.summary.failsByAudit[auditName] = auditFails;
    results.summary.totalFails += auditFails;
  }

  // ═══════════════════════════════════════════════════════════
  // Build worst pages list
  // ═══════════════════════════════════════════════════════════

  const pageFailCounts = {};
  for (const [pageUrl, audits] of Object.entries(results.pages)) {
    pageFailCounts[pageUrl] = (pageFailCounts[pageUrl] || 0)
      + Object.values(audits).reduce((s, r) => s + r.failCount, 0);
  }
  for (const [pageUrl, audits] of Object.entries(results.sampled)) {
    pageFailCounts[pageUrl] = (pageFailCounts[pageUrl] || 0)
      + Object.values(audits).reduce((s, r) => s + r.failCount, 0);
  }

  results.summary.worstPages = Object.entries(pageFailCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, SITE_AUDIT.ci.summaryMaxPages)
    .map(([url, fails]) => ({ url, fails }));

  results.summary.sampledPageUrls = sampledPages;

  return results;
}
