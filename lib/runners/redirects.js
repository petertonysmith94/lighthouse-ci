/**
 * Redirects Runner
 * ────────────────
 * Validates redirects, internal links, and 404 pages.
 * Covers §9 — Redirects & Routing.
 */

import { chromium } from 'playwright';
import { readFileSync, existsSync } from 'fs';
import { REDIRECTS } from '../config.js';

/**
 * @param {object} opts
 * @param {string} opts.url
 * @param {import('playwright').Cookie[]} [opts.authCookieObjects]
 * @param {object} [opts.options] - { redirectsFile, check404, checkLinks, timeout }
 * @returns {Promise<RunnerResult>}
 */
export async function runRedirectChecker({ url, authCookieObjects, options = {} }) {
  const timeout = options.timeout || REDIRECTS.navigationTimeout;

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();

  if (authCookieObjects) {
    await context.addCookies(authCookieObjects);
  }

  const checks = [];
  const warnings = [];
  const data = { redirects: [], links: [], custom404: null, externalLinks: [] };
  let failCount = 0;

  // ── 1. Check Redirect Map ────────────────────────────────
  if (options.redirectsFile) {
    if (!existsSync(options.redirectsFile)) {
      checks.push({ label: 'Redirect map file', passed: false, message: `Redirect map file not found: ${options.redirectsFile}` });
      failCount++;
    } else {
      const redirectMap = JSON.parse(readFileSync(options.redirectsFile, 'utf-8'));

      for (const { from, to } of redirectMap) {
        const page = await context.newPage();
        try {
          const response = await page.goto(from, { waitUntil: 'commit', timeout });
          const finalUrl = page.url();
          const status = response?.status();
          const normalise = u => u.replace(/\/$/, '').toLowerCase();
          const landed = normalise(finalUrl) === normalise(to);

          if (landed) {
            checks.push({ label: `Redirect ${from}`, passed: true, message: `${from} → ${to}` });
            data.redirects.push({ from, to, actual: finalUrl, status, passed: true });
          } else {
            checks.push({ label: `Redirect ${from}`, passed: false, message: `${from} → expected ${to}, got ${finalUrl} (status: ${status})` });
            data.redirects.push({ from, to, actual: finalUrl, status, passed: false });
            failCount++;
          }
        } catch (err) {
          checks.push({ label: `Redirect ${from}`, passed: false, message: `${from} → ERROR: ${err.message}` });
          data.redirects.push({ from, to, error: err.message, passed: false });
          failCount++;
        }
        await page.close();
      }
    }
  }

  // ── 2. Check Internal Links ──────────────────────────────
  if (options.checkLinks) {
    const linkPage = await context.newPage();
    await linkPage.goto(url, { waitUntil: 'domcontentloaded' });

    const links = await linkPage.evaluate((textTruncate) => {
      const anchors = document.querySelectorAll('a[href]');
      return Array.from(anchors).map(a => ({
        href: a.href,
        text: a.textContent?.trim().slice(0, textTruncate),
        isInternal: a.href.startsWith(window.location.origin),
        isExternal: !a.href.startsWith(window.location.origin) && a.href.startsWith('http'),
      }));
    }, REDIRECTS.display.linkTextTruncate);

    const internalLinks = links.filter(l => l.isInternal);
    const externalLinks = links.filter(l => l.isExternal);
    const uniqueInternals = [...new Set(internalLinks.map(l => l.href))];
    const uniqueExternal = [...new Set(externalLinks.map(l => l.href))];

    data.externalLinks = uniqueExternal;

    for (const linkUrl of uniqueInternals) {
      const checkPage = await context.newPage();
      try {
        const response = await checkPage.goto(linkUrl, { waitUntil: 'commit', timeout });
        const status = response?.status();

        if (status >= 200 && status < 400) {
          data.links.push({ url: linkUrl, status, passed: true });
        } else {
          checks.push({ label: `Link ${linkUrl}`, passed: false, message: `Broken link: ${linkUrl} (status: ${status})` });
          data.links.push({ url: linkUrl, status, passed: false });
          failCount++;
        }
      } catch (err) {
        checks.push({ label: `Link ${linkUrl}`, passed: false, message: `Broken link: ${linkUrl} (${err.message})` });
        data.links.push({ url: linkUrl, error: err.message, passed: false });
        failCount++;
      }
      await checkPage.close();
    }

    const brokenLinks = data.links.filter(l => !l.passed);
    if (brokenLinks.length === 0) {
      checks.push({ label: 'Internal links', passed: true, message: `All ${uniqueInternals.length} internal links are valid` });
    }

    await linkPage.close();
  }

  // ── 3. Custom 404 Page ───────────────────────────────────
  if (options.check404) {
    const page404 = await context.newPage();
    const randomPath = `/this-page-does-not-exist-${Date.now()}`;
    const testUrl = new URL(randomPath, url).toString();

    try {
      const response = await page404.goto(testUrl, { waitUntil: 'domcontentloaded', timeout });
      const status = response?.status();
      const content = await page404.content();

      const cfg = REDIRECTS.custom404;
      const hasNavigation = cfg.navDetectors.some(d => content.includes(d));
      const hasHomeLink = cfg.homeLinkDetectors.some(d => content.includes(d));
      const isCustom = content.length > cfg.minContentLength && hasNavigation;

      data.custom404 = { url: testUrl, status, isCustom, hasNavigation, hasHomeLink };

      if (status === 404 && isCustom) {
        checks.push({ label: 'Custom 404 page', passed: true, message: 'Custom 404 page renders correctly' });
        if (hasHomeLink) {
          checks.push({ label: '404 home link', passed: true, message: '404 page includes navigation/home link' });
        } else {
          warnings.push('404 page may not include link back to home');
        }
      } else if (status === 404) {
        warnings.push('404 page exists but may be generic/minimal');
      } else {
        checks.push({ label: 'Custom 404 page', passed: false, message: `Expected 404 status, got ${status} for ${testUrl}` });
        failCount++;
      }
    } catch (err) {
      checks.push({ label: 'Custom 404 page', passed: false, message: `404 check failed: ${err.message}` });
      failCount++;
    }

    await page404.close();
  }

  await browser.close();

  return {
    passed: failCount === 0,
    failCount,
    data,
    checks,
    warnings,
    manualChecks: [],
  };
}
