/**
 * Link Checker Runner
 * ───────────────────
 * BFS crawl from a starting URL, discovering internal links and validating them.
 * Reports broken links (4xx/5xx) and collects external links for review.
 */

import { chromium } from 'playwright';
import { LINK_CHECKER } from '../config.js';

/**
 * @param {object} opts
 * @param {string} opts.url
 * @param {import('playwright').Cookie[]} [opts.authCookieObjects]
 * @param {object} [opts.options] - { maxPages, checkExternal, timeout }
 * @returns {Promise<RunnerResult>}
 */
export async function runLinkChecker({ url, authCookieObjects, options = {} }) {
  const maxPages = options.maxPages || LINK_CHECKER.maxPages;
  const timeout = options.timeout || LINK_CHECKER.navigationTimeout;
  const checkExternal = options.checkExternal || false;

  const origin = new URL(url).origin;

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();

  if (authCookieObjects) {
    await context.addCookies(authCookieObjects);
  }

  const visited = new Map();       // url → { status, error? }
  const queue = [normalise(url)];  // BFS queue of internal URLs
  const externalLinks = new Set();
  const brokenLinks = [];
  const pages = [];

  // ── BFS Crawl ───────────────────────────────────────────
  while (queue.length > 0 && visited.size < maxPages) {
    const currentUrl = queue.shift();
    if (visited.has(currentUrl)) continue;

    const page = await context.newPage();
    let status = null;
    let error = null;

    try {
      const response = await page.goto(currentUrl, {
        waitUntil: 'domcontentloaded',
        timeout,
      });
      status = response?.status() ?? null;

      // Wait briefly for lazy content
      await page.waitForTimeout(LINK_CHECKER.settleTimeout);

      // Extract all <a href> links
      const hrefs = await page.evaluate(() => {
        const anchors = document.querySelectorAll('a[href]');
        return Array.from(anchors).map(a => a.href).filter(h => h.startsWith('http'));
      });

      for (const href of hrefs) {
        const cleaned = normalise(href);
        if (cleaned.startsWith(origin)) {
          if (!visited.has(cleaned) && !queue.includes(cleaned)) {
            queue.push(cleaned);
          }
        } else {
          externalLinks.add(href);
        }
      }
    } catch (err) {
      error = err.message;
    }

    await page.close();

    const entry = { url: currentUrl, status, error };
    visited.set(currentUrl, entry);
    pages.push(entry);

    if (error || (status !== null && status >= 400)) {
      brokenLinks.push(entry);
    }
  }

  // ── External Link Validation (optional) ─────────────────
  const externalResults = [];
  if (checkExternal) {
    for (const extUrl of externalLinks) {
      const page = await context.newPage();
      try {
        const response = await page.goto(extUrl, {
          waitUntil: 'commit',
          timeout,
        });
        const status = response?.status() ?? null;
        const ok = status !== null && status < 400;
        externalResults.push({ url: extUrl, status, passed: ok });
        if (!ok) {
          brokenLinks.push({ url: extUrl, status, external: true });
        }
      } catch (err) {
        externalResults.push({ url: extUrl, error: err.message, passed: false });
        brokenLinks.push({ url: extUrl, error: err.message, external: true });
      }
      await page.close();
    }
  }

  await browser.close();

  // ── Build Result ────────────────────────────────────────
  const checks = [];
  const warnings = [];

  for (const link of brokenLinks) {
    const detail = link.error
      ? `${link.url} — ${link.error}`
      : `${link.url} (status: ${link.status})`;
    checks.push({
      label: `Broken link${link.external ? ' (external)' : ''}`,
      passed: false,
      message: detail,
    });
  }

  if (brokenLinks.length === 0) {
    checks.push({
      label: 'Link check',
      passed: true,
      message: `All ${visited.size} crawled pages returned valid responses`,
    });
  }

  if (visited.size >= maxPages) {
    warnings.push(`Crawl stopped at max pages limit (${maxPages}). Increase --max-pages to crawl more.`);
  }

  const stats = {
    pagesCrawled: visited.size,
    brokenCount: brokenLinks.filter(l => !l.external).length,
    brokenExternalCount: brokenLinks.filter(l => l.external).length,
    externalLinksFound: externalLinks.size,
    maxPagesHit: visited.size >= maxPages,
  };

  return {
    passed: brokenLinks.length === 0,
    failCount: brokenLinks.length,
    data: {
      pages,
      brokenLinks,
      externalLinks: [...externalLinks],
      externalResults,
      stats,
    },
    checks,
    warnings,
    manualChecks: [],
  };
}

function normalise(url) {
  try {
    const u = new URL(url);
    // Strip hash, keep path without trailing slash (except root)
    u.hash = '';
    if (u.pathname !== '/') {
      u.pathname = u.pathname.replace(/\/$/, '');
    }
    return u.toString();
  } catch {
    return url;
  }
}
