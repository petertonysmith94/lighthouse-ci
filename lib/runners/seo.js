/**
 * SEO Runner
 * ──────────
 * Checks a page for SEO requirements from the Plasma spec.
 * Uses Playwright to render the page and inspect the DOM.
 * Covers §4 — SEO.
 */

import { chromium } from 'playwright';
import { SEO } from '../config.js';

/**
 * @param {object} opts
 * @param {string} opts.url
 * @param {import('playwright').Cookie[]} [opts.authCookieObjects]
 * @param {object} [opts.options] - { checkSsr: boolean }
 * @returns {Promise<RunnerResult>}
 */
export async function runSeoAudit({ url, authCookieObjects, options = {} }) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();

  if (authCookieObjects) {
    await context.addCookies(authCookieObjects);
  }

  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(SEO.settleTimeout);

  const checks = [];
  const warnings = [];
  const data = {};

  // ── 1. Title Tag ─────────────────────────────────────────
  const title = await page.title();
  if (title && title.length > 0 && title !== 'Untitled') {
    checks.push({ label: 'Title tag', passed: true, message: `Title: "${title.slice(0, SEO.display.titleTruncate)}${title.length > SEO.display.titleTruncate ? '...' : ''}"` });
    if (title.length > SEO.metaLengthLimits.titleWarn) {
      warnings.push(`Title is ${title.length} chars (recommended: < ${SEO.metaLengthLimits.titleWarn})`);
    }
  } else {
    checks.push({ label: 'Title tag', passed: false, message: 'Missing or empty <title> tag' });
  }

  // ── 2. Meta Description ──────────────────────────────────
  const metaDesc = await page.$eval(
    'meta[name="description"]', el => el.getAttribute('content')
  ).catch(() => null);

  if (metaDesc && metaDesc.length > 0) {
    checks.push({ label: 'Meta description', passed: true, message: `Meta description: "${metaDesc.slice(0, SEO.display.descriptionTruncate)}${metaDesc.length > SEO.display.descriptionTruncate ? '...' : ''}"` });
    if (metaDesc.length > SEO.metaLengthLimits.descriptionWarn) {
      warnings.push(`Description is ${metaDesc.length} chars (recommended: < ${SEO.metaLengthLimits.descriptionWarn})`);
    }
  } else {
    checks.push({ label: 'Meta description', passed: false, message: 'Missing <meta name="description">' });
  }

  // ── 3. Canonical URL ─────────────────────────────────────
  const canonical = await page.$eval(
    'link[rel="canonical"]', el => el.getAttribute('href')
  ).catch(() => null);

  if (canonical) {
    checks.push({ label: 'Canonical URL', passed: true, message: `Canonical URL: ${canonical}` });
  } else {
    checks.push({ label: 'Canonical URL', passed: false, message: 'Missing <link rel="canonical">' });
  }

  // ── 4. Open Graph Tags ──────────────────────────────────
  const ogTags = await page.evaluate((required) => {
    const tags = {};
    required.forEach(name => {
      const el = document.querySelector(`meta[property="${name}"]`);
      tags[name] = el ? el.getAttribute('content') : null;
    });
    return tags;
  }, SEO.requiredOgTags);

  const ogMissing = Object.entries(ogTags).filter(([, v]) => !v);
  if (ogMissing.length === 0) {
    checks.push({ label: 'Open Graph tags', passed: true, message: 'All Open Graph tags present (title, description, image, url, type)' });
  } else {
    checks.push({ label: 'Open Graph tags', passed: false, message: `Missing OG tags: ${ogMissing.map(([k]) => k).join(', ')}` });
  }

  // ── 5. Twitter Card Tags ─────────────────────────────────
  const twitterTags = await page.evaluate((required) => {
    const tags = {};
    required.forEach(name => {
      const el = document.querySelector(`meta[name="${name}"], meta[property="${name}"]`);
      tags[name] = el ? el.getAttribute('content') : null;
    });
    return tags;
  }, SEO.requiredTwitterTags);

  const twMissing = Object.entries(twitterTags).filter(([, v]) => !v);
  if (twMissing.length === 0) {
    checks.push({ label: 'Twitter Card tags', passed: true, message: 'All Twitter Card tags present' });
  } else {
    checks.push({ label: 'Twitter Card tags', passed: false, message: `Missing Twitter Card tags: ${twMissing.map(([k]) => k).join(', ')}` });
  }

  // ── 6. JSON-LD Structured Data ───────────────────────────
  const jsonLd = await page.evaluate((truncate) => {
    const scripts = document.querySelectorAll('script[type="application/ld+json"]');
    return Array.from(scripts).map(s => {
      try {
        return JSON.parse(s.textContent);
      } catch {
        return { _error: 'Invalid JSON-LD', raw: s.textContent?.slice(0, truncate) };
      }
    });
  }, SEO.display.jsonLdRawTruncate);

  if (jsonLd.length > 0) {
    checks.push({ label: 'JSON-LD', passed: true, message: `${jsonLd.length} JSON-LD block(s) found` });

    const types = jsonLd.map(j => j['@type'] || (j['@graph'] ? 'Graph' : 'Unknown'));
    const foundTypes = types.flat();

    const errors = jsonLd.filter(j => j._error);
    if (errors.length > 0) {
      checks.push({ label: 'JSON-LD validity', passed: false, message: `${errors.length} JSON-LD block(s) have invalid JSON` });
    }

    data.jsonLdTypes = foundTypes;
    data.jsonLdExpected = {};
    for (const t of SEO.expectedJsonLdTypes) {
      data.jsonLdExpected[t] = foundTypes.includes(t);
    }
  } else {
    checks.push({ label: 'JSON-LD', passed: false, message: 'No JSON-LD structured data found' });
  }

  // ── 7. Semantic HTML5 ────────────────────────────────────
  const semantics = await page.evaluate(([elements, headingTruncate]) => {
    const found = {};
    elements.forEach(tag => {
      found[tag] = document.querySelectorAll(tag).length;
    });

    const headings = [];
    document.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach(h => {
      headings.push({ level: parseInt(h.tagName[1]), text: h.textContent?.trim().slice(0, headingTruncate) });
    });

    return { elements: found, headings };
  }, [SEO.semanticElements, SEO.display.headingTextTruncate]);

  const presentElements = Object.entries(semantics.elements).filter(([, count]) => count > 0);
  if (presentElements.length >= SEO.minSemanticElements) {
    checks.push({ label: 'Semantic HTML', passed: true, message: `Semantic elements used: ${presentElements.map(([tag, count]) => `<${tag}> (${count})`).join(', ')}` });
  } else {
    warnings.push(`Only ${presentElements.length} semantic element types found (recommend: main, nav, section, footer at minimum)`);
  }

  // H1 check
  const h1s = semantics.headings.filter(h => h.level === 1);
  if (h1s.length === 1) {
    checks.push({ label: 'H1 tag', passed: true, message: `Single <h1>: "${h1s[0].text}"` });
  } else if (h1s.length === 0) {
    checks.push({ label: 'H1 tag', passed: false, message: 'No <h1> tag found' });
  } else {
    warnings.push(`${h1s.length} <h1> tags found (should be exactly 1)`);
  }

  // Heading hierarchy
  const levels = semantics.headings.map(h => h.level);
  let hierarchyClean = true;
  for (let i = 1; i < levels.length; i++) {
    if (levels[i] > levels[i - 1] + 1) {
      warnings.push(`Heading hierarchy skip: h${levels[i - 1]} → h${levels[i]}`);
      hierarchyClean = false;
      break;
    }
  }
  if (hierarchyClean && levels.length > 0) {
    checks.push({ label: 'Heading hierarchy', passed: true, message: 'Heading hierarchy is sequential (no skipped levels)' });
  }

  // ── 8. Image Alt Text ────────────────────────────────────
  const imageData = await page.evaluate(([srcTruncate, classTruncate]) => {
    const images = document.querySelectorAll('img');
    const results = { total: images.length, withAlt: 0, withoutAlt: [], decorative: 0 };
    images.forEach(img => {
      const alt = img.getAttribute('alt');
      if (alt === '') {
        results.decorative++;
      } else if (alt && alt.length > 0) {
        results.withAlt++;
      } else {
        results.withoutAlt.push({
          src: img.src?.slice(0, srcTruncate),
          class: img.className?.toString().slice(0, classTruncate),
        });
      }
    });
    return results;
  }, [SEO.display.imgSrcTruncate, SEO.display.imgClassTruncate]);

  if (imageData.withoutAlt.length === 0) {
    checks.push({ label: 'Image alt text', passed: true, message: `All ${imageData.total} images have alt text (${imageData.decorative} decorative)` });
  } else {
    checks.push({ label: 'Image alt text', passed: false, message: `${imageData.withoutAlt.length} of ${imageData.total} images missing alt text` });
  }

  // ── 9. SSR Check (optional or always in full audit) ──────
  let ssrData = null;
  if (options.checkSsr) {
    const noJsContext = await browser.newContext({ javaScriptEnabled: false });

    if (authCookieObjects) {
      await noJsContext.addCookies(authCookieObjects);
    }

    const noJsPage = await noJsContext.newPage();
    await noJsPage.goto(url, { waitUntil: 'commit', timeout: SEO.ssr.timeout }).catch(() => {});

    const noJsContent = await noJsPage.content();
    const noJsTitle = await noJsPage.title().catch(() => '');
    const hasSSRContent = noJsContent.length > SEO.ssr.minContentLength && noJsTitle.length > 0;
    const hasMetaInSSR = noJsContent.includes(SEO.ssr.metaSelector);

    ssrData = { hasContent: hasSSRContent, hasMeta: hasMetaInSSR, htmlLength: noJsContent.length };

    if (hasSSRContent && hasMetaInSSR) {
      checks.push({ label: 'SSR', passed: true, message: 'Page is server-side rendered (content present without JS)' });
    } else {
      checks.push({ label: 'SSR', passed: false, message: 'Page may be client-only rendered (little content without JS)' });
    }

    await noJsContext.close();
  }

  await browser.close();

  const failCount = checks.filter(c => !c.passed).length;

  return {
    passed: failCount === 0,
    failCount,
    data: {
      title,
      metaDescription: metaDesc,
      canonical,
      openGraph: ogTags,
      twitterCard: twitterTags,
      jsonLd: jsonLd.map(j => ({ type: j['@type'], hasError: !!j._error })),
      semanticHTML: semantics.elements,
      headings: semantics.headings,
      images: {
        total: imageData.total,
        withAlt: imageData.withAlt,
        decorative: imageData.decorative,
        missingAlt: imageData.withoutAlt.length,
        missingElements: imageData.withoutAlt,
      },
      ssr: ssrData,
    },
    checks,
    warnings,
    manualChecks: SEO.reminders,
  };
}
