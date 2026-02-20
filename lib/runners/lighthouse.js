/**
 * Lighthouse Runner
 * ─────────────────
 * Runs Google Lighthouse against a URL and returns structured results.
 * Covers §3 Performance and §4 SEO (Lighthouse scores).
 */

import lighthouse from 'lighthouse';
import { launch } from 'chrome-launcher';
import { THRESHOLDS, LIGHTHOUSE } from '../config.js';

function makeCheck(label, value, threshold, unit, lowerIsBetter) {
  const passed = lowerIsBetter ? value <= threshold : value >= threshold;
  return { label, passed, value, threshold, unit, lowerIsBetter };
}

function extractScores(lhr) {
  return {
    performance: Math.round(lhr.categories.performance.score * 100),
    seo: Math.round(lhr.categories.seo?.score * 100 || 0),
    accessibility: Math.round(lhr.categories.accessibility?.score * 100 || 0),
    bestPractices: Math.round(lhr.categories['best-practices']?.score * 100 || 0),
  };
}

function extractCoreWebVitals(lhr) {
  const metrics = lhr.audits.metrics?.details?.items?.[0] || {};
  return {
    lcp: Math.round(metrics[LIGHTHOUSE.metricKeys.lcp] || 0),
    fid: Math.round(metrics[LIGHTHOUSE.metricKeys.fid] || 0),
    cls: parseFloat((lhr.audits[LIGHTHOUSE.metricKeys.cls]?.numericValue || 0).toFixed(3)),
    ttfb: Math.round(metrics[LIGHTHOUSE.metricKeys.ttfb] || 0),
  };
}

function extractFailedAudits(lhr) {
  return Object.entries(lhr.audits)
    .filter(([, audit]) => audit.score !== null && audit.score < LIGHTHOUSE.failedAuditThreshold)
    .map(([id, audit]) => ({
      id,
      title: audit.title,
      score: audit.score,
      description: audit.description?.slice(0, 120),
    }));
}

async function runStrategy(url, strategy, authCookies, categories) {
  const config = LIGHTHOUSE.strategies[strategy];
  const chrome = await launch({ chromeFlags: LIGHTHOUSE.chromeFlags });

  try {
    const result = await lighthouse(url, {
      logLevel: 'error',
      output: 'json',
      port: chrome.port,
      onlyCategories: categories || LIGHTHOUSE.categories,
      formFactor: config.formFactor,
      screenEmulation: config.screenEmulation,
      throttling: config.throttling,
      extraHeaders: authCookies ? { Cookie: authCookies } : undefined,
    });

    const { lhr } = result;
    const scores = extractScores(lhr);
    const cwv = extractCoreWebVitals(lhr);
    const failedAudits = extractFailedAudits(lhr);

    const scoreTarget = strategy === 'mobile'
      ? THRESHOLDS.performance.mobileScore
      : THRESHOLDS.performance.desktopScore;

    const checks = [
      makeCheck(`PageSpeed (${strategy === 'mobile' ? 'Mobile' : 'Desktop'})`, scores.performance, scoreTarget, '', false),
      makeCheck('LCP', cwv.lcp, THRESHOLDS.performance.lcp, 'ms', true),
      makeCheck('FID (max potential)', cwv.fid, THRESHOLDS.performance.fid, 'ms', true),
      makeCheck('CLS', cwv.cls, THRESHOLDS.performance.cls, '', true),
      makeCheck('TTFB', cwv.ttfb, THRESHOLDS.performance.ttfb, 'ms', true),
      makeCheck(`SEO Score (${strategy === 'mobile' ? 'Mobile' : 'Desktop'})`, scores.seo, THRESHOLDS.seo.lighthouseScore, '', false),
    ];

    return { strategy, scores, coreWebVitals: cwv, checks, failedAudits, fullReport: lhr };
  } finally {
    await chrome.kill();
  }
}

async function run3gTest(url, authCookies) {
  const config = LIGHTHOUSE.throttle3g;
  const chrome = await launch({ chromeFlags: LIGHTHOUSE.chromeFlags });

  try {
    const result = await lighthouse(url, {
      logLevel: 'error',
      output: 'json',
      port: chrome.port,
      onlyCategories: config.categories,
      formFactor: config.formFactor,
      screenEmulation: config.screenEmulation,
      throttling: config.throttling,
      extraHeaders: authCookies ? { Cookie: authCookies } : undefined,
    });

    const interactive = Math.round(result.lhr.audits[LIGHTHOUSE.metricKeys.interactive]?.numericValue || 0);
    const check = makeCheck('Time to Interactive (3G)', interactive, THRESHOLDS.throttledLoad, 'ms', true);

    return {
      timeToInteractive: interactive,
      threshold: THRESHOLDS.throttledLoad,
      passed: interactive <= THRESHOLDS.throttledLoad,
      checks: [check],
    };
  } finally {
    await chrome.kill();
  }
}

/**
 * @param {object} opts
 * @param {string} opts.url
 * @param {string} [opts.authCookies] - Cookie string for Lighthouse headers
 * @param {object} [opts.options] - { strategy: 'mobile'|'desktop'|'both', throttle3g: boolean, categories: string[] }
 * @returns {Promise<RunnerResult>}
 */
export async function runLighthouseAudit({ url, authCookies, options = {} }) {
  const strategy = options.strategy || 'both';
  const strategies = strategy === 'both' ? ['mobile', 'desktop'] : [strategy];
  const categories = options.categories;

  const strategyResults = {};
  const allChecks = [];
  const warnings = [];

  for (const s of strategies) {
    const result = await runStrategy(url, s, authCookies, categories);
    strategyResults[s] = result;
    allChecks.push(...result.checks);

    if (result.failedAudits.length > 0) {
      warnings.push(`${s}: ${result.failedAudits.length} audits scored below 50%`);
    }
  }

  // Optional 3G test
  let result3g = null;
  if (options.throttle3g) {
    result3g = await run3gTest(url, authCookies);
    strategyResults['3g'] = result3g;
    allChecks.push(...result3g.checks);
  }

  const failCount = allChecks.filter(c => !c.passed).length;

  return {
    passed: failCount === 0,
    failCount,
    data: strategyResults,
    checks: allChecks,
    warnings,
    manualChecks: [],
  };
}
