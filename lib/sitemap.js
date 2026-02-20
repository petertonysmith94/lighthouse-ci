/**
 * Sitemap Discovery & Parsing
 * ───────────────────────────
 * Fetches /sitemap.xml from a preview URL using Playwright (needed because
 * previews are password-protected), parses it, and returns a list of page URLs.
 *
 * Handles <sitemapindex> (sitemap of sitemaps) with recursive fetching.
 * Falls back to a BFS crawl if no sitemap is found.
 */

import { chromium } from 'playwright';
import { SITEMAP } from './config.js';

/**
 * Discover all pages on a site via sitemap.xml or fallback crawl.
 *
 * @param {object} opts
 * @param {string} opts.baseUrl - The base URL (e.g. https://preview.vercel.app)
 * @param {import('playwright').Cookie[]} [opts.authCookieObjects]
 * @param {object} [opts.options]
 * @param {string} [opts.options.sitemapPath] - Override sitemap path (default: /sitemap.xml)
 * @param {number} [opts.options.maxPages] - Max pages to return
 * @returns {Promise<{ source: string, urls: string[], warnings: string[] }>}
 */
export async function discoverPages({ baseUrl, authCookieObjects, options = {} }) {
  const sitemapPath = options.sitemapPath || SITEMAP.defaultPath;
  const maxPages = options.maxPages || SITEMAP.maxPages;
  const warnings = [];

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();

  if (authCookieObjects) {
    await context.addCookies(authCookieObjects);
  }

  try {
    // Try fetching the sitemap
    const sitemapUrl = new URL(sitemapPath, baseUrl).toString();
    const result = await fetchSitemap(context, sitemapUrl, 0, warnings);

    if (result.urls.length > 0) {
      const deduplicated = deduplicateUrls(result.urls);
      const limited = deduplicated.slice(0, maxPages);

      if (deduplicated.length > maxPages) {
        warnings.push(`Sitemap contains ${deduplicated.length} URLs, limited to ${maxPages}`);
      }

      return { source: result.source, urls: limited, warnings };
    }

    // Fallback: BFS crawl
    warnings.push('No sitemap found or sitemap was empty — falling back to crawl');
    const crawledUrls = await fallbackCrawl(context, baseUrl);

    return { source: 'crawl', urls: crawledUrls.slice(0, maxPages), warnings };
  } finally {
    await browser.close();
  }
}

/**
 * Fetch and parse a sitemap URL. Handles both <urlset> and <sitemapindex>.
 */
async function fetchSitemap(context, sitemapUrl, depth, warnings) {
  if (depth > SITEMAP.maxIndexDepth) {
    warnings.push(`Sitemap index depth exceeded (${depth}), stopping recursion`);
    return { source: 'sitemap-index', urls: [] };
  }

  const page = await context.newPage();

  try {
    const response = await page.goto(sitemapUrl, {
      waitUntil: 'domcontentloaded',
      timeout: SITEMAP.fetchTimeout,
    });

    const status = response?.status();
    if (!status || status >= 400) {
      return { source: 'sitemap', urls: [] };
    }

    // Parse XML in the browser using DOMParser
    const parsed = await page.evaluate(() => {
      const text = document.querySelector('pre')?.textContent
        || document.body.innerText
        || new XMLSerializer().serializeToString(document);

      const parser = new DOMParser();
      const doc = parser.parseFromString(text, 'text/xml');

      const parseError = doc.querySelector('parsererror');
      if (parseError) {
        return { error: 'XML parse error', urls: [], sitemapUrls: [] };
      }

      // Check if this is a sitemap index
      const sitemapLocs = Array.from(doc.querySelectorAll('sitemapindex > sitemap > loc'));
      if (sitemapLocs.length > 0) {
        return {
          type: 'index',
          urls: [],
          sitemapUrls: sitemapLocs.map(el => el.textContent.trim()),
        };
      }

      // Regular urlset
      const urlLocs = Array.from(doc.querySelectorAll('urlset > url > loc'));
      return {
        type: 'urlset',
        urls: urlLocs.map(el => el.textContent.trim()),
        sitemapUrls: [],
      };
    });

    if (parsed.error) {
      warnings.push(`Failed to parse sitemap at ${sitemapUrl}: ${parsed.error}`);
      return { source: 'sitemap', urls: [] };
    }

    // Sitemap index — recurse into each child sitemap
    if (parsed.type === 'index') {
      const allUrls = [];
      for (const childUrl of parsed.sitemapUrls) {
        const childResult = await fetchSitemap(context, childUrl, depth + 1, warnings);
        allUrls.push(...childResult.urls);
      }
      return { source: 'sitemap-index', urls: allUrls };
    }

    // Regular urlset
    return { source: 'sitemap', urls: parsed.urls };
  } catch (err) {
    warnings.push(`Failed to fetch sitemap at ${sitemapUrl}: ${err.message}`);
    return { source: 'sitemap', urls: [] };
  } finally {
    await page.close();
  }
}

/**
 * BFS crawl fallback — discovers pages by following internal links.
 */
async function fallbackCrawl(context, baseUrl) {
  const maxPages = SITEMAP.fallbackCrawlMaxPages;
  const origin = new URL(baseUrl).origin;
  const visited = new Set();
  const queue = [normaliseUrl(baseUrl)];
  const discovered = [];

  while (queue.length > 0 && discovered.length < maxPages) {
    const currentUrl = queue.shift();
    if (visited.has(currentUrl)) continue;
    visited.add(currentUrl);

    const page = await context.newPage();
    try {
      const response = await page.goto(currentUrl, {
        waitUntil: 'domcontentloaded',
        timeout: SITEMAP.fetchTimeout,
      });

      const status = response?.status();
      if (status && status >= 200 && status < 400) {
        discovered.push(currentUrl);

        const hrefs = await page.evaluate(() => {
          return Array.from(document.querySelectorAll('a[href]'))
            .map(a => a.href)
            .filter(h => h.startsWith('http'));
        });

        for (const href of hrefs) {
          const cleaned = normaliseUrl(href);
          if (cleaned.startsWith(origin) && !visited.has(cleaned)) {
            queue.push(cleaned);
          }
        }
      }
    } catch {
      // Skip pages that fail to load
    }
    await page.close();
  }

  return discovered;
}

/**
 * Normalise a URL: strip hash, trailing slash (except root), lowercase host.
 */
function normaliseUrl(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    if (u.pathname !== '/') {
      u.pathname = u.pathname.replace(/\/$/, '');
    }
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * Deduplicate URLs after normalisation.
 */
function deduplicateUrls(urls) {
  const seen = new Set();
  const result = [];
  for (const url of urls) {
    const normalised = normaliseUrl(url);
    if (!seen.has(normalised)) {
      seen.add(normalised);
      result.push(normalised);
    }
  }
  return result;
}
