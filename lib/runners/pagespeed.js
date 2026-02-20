/**
 * PageSpeed Diagnostics Runner
 * ────────────────────────────
 * Playwright-based performance profiler with optional Google PSI API enrichment.
 * Captures render-blocking resources, long tasks, CLS sources, unused code,
 * and resource waterfall using Performance APIs and CDP sessions.
 */

import { chromium } from 'playwright';
import { PAGESPEED } from '../config.js';

function makeCheck(label, value, threshold, unit, lowerIsBetter, category) {
  const passed = lowerIsBetter ? value <= threshold : value >= threshold;
  return { label, passed, value, threshold, unit, lowerIsBetter, category };
}

/**
 * Helper: generate a CSS selector path for an element (injected into page context).
 */
function cssPathScript() {
  return `
    function cssPath(el) {
      if (!el || el === document) return '';
      const parts = [];
      while (el && el.nodeType === 1) {
        let selector = el.tagName.toLowerCase();
        if (el.id) {
          selector += '#' + el.id;
          parts.unshift(selector);
          break;
        }
        const parent = el.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children).filter(c => c.tagName === el.tagName);
          if (siblings.length > 1) {
            selector += ':nth-of-type(' + (siblings.indexOf(el) + 1) + ')';
          }
        }
        parts.unshift(selector);
        el = parent;
      }
      return parts.join(' > ');
    }
  `;
}

/**
 * Phase 1: Playwright capture — PerformanceObserver + Resource/Navigation Timing
 */
async function capturePerformanceData(page, url, settleTimeout) {
  // Inject PerformanceObserver before navigation
  await page.addInitScript(`
    ${cssPathScript()}

    window.__perfData = {
      longTasks: [],
      layoutShifts: [],
      lcpEntry: null,
      fcpTime: null,
    };

    // Long Tasks
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          window.__perfData.longTasks.push({
            startTime: entry.startTime,
            duration: entry.duration,
          });
        }
      }).observe({ type: 'longtask', buffered: true });
    } catch (e) {}

    // Layout Shifts
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.hadRecentInput) continue;
          const sources = (entry.sources || []).map(s => {
            let selector = '';
            try { selector = s.node ? cssPath(s.node) : ''; } catch (e) {}
            return {
              selector,
              previousRect: s.previousRect ? {
                x: s.previousRect.x, y: s.previousRect.y,
                width: s.previousRect.width, height: s.previousRect.height,
              } : null,
              currentRect: s.currentRect ? {
                x: s.currentRect.x, y: s.currentRect.y,
                width: s.currentRect.width, height: s.currentRect.height,
              } : null,
            };
          });
          window.__perfData.layoutShifts.push({
            value: entry.value,
            startTime: entry.startTime,
            sources,
          });
        }
      }).observe({ type: 'layout-shift', buffered: true });
    } catch (e) {}

    // LCP
    try {
      new PerformanceObserver((list) => {
        const entries = list.getEntries();
        const last = entries[entries.length - 1];
        if (last) {
          let selector = '';
          try { selector = last.element ? cssPath(last.element) : ''; } catch (e) {}
          window.__perfData.lcpEntry = {
            startTime: last.startTime,
            size: last.size,
            url: last.url || '',
            selector,
            tagName: last.element?.tagName?.toLowerCase() || '',
          };
        }
      }).observe({ type: 'largest-contentful-paint', buffered: true });
    } catch (e) {}

    // FCP
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.name === 'first-contentful-paint') {
            window.__perfData.fcpTime = entry.startTime;
          }
        }
      }).observe({ type: 'paint', buffered: true });
    } catch (e) {}

    // Expand resource timing buffer
    if (performance.setResourceTimingBufferSize) {
      performance.setResourceTimingBufferSize(${PAGESPEED.capture.resourceTimingBufferSize});
    }
  `);

  // Navigate
  await page.goto(url, {
    waitUntil: 'load',
    timeout: PAGESPEED.capture.navigationTimeout,
  });

  // Settle for dynamic content
  await page.waitForTimeout(settleTimeout);

  // Extract all data
  const data = await page.evaluate(() => {
    const navEntry = performance.getEntriesByType('navigation')[0] || {};
    const resources = performance.getEntriesByType('resource').map(r => ({
      name: r.name,
      initiatorType: r.initiatorType,
      transferSize: r.transferSize || 0,
      encodedBodySize: r.encodedBodySize || 0,
      decodedBodySize: r.decodedBodySize || 0,
      duration: r.duration,
      startTime: r.startTime,
      responseEnd: r.responseEnd,
      renderBlockingStatus: r.renderBlockingStatus,
    }));

    const navigationTiming = {
      ttfb: navEntry.responseStart - navEntry.requestStart || 0,
      domContentLoaded: navEntry.domContentLoadedEventEnd - navEntry.startTime || 0,
      domInteractive: navEntry.domInteractive - navEntry.startTime || 0,
      loadEvent: navEntry.loadEventEnd - navEntry.startTime || 0,
    };

    return {
      observerData: window.__perfData,
      resources,
      navigationTiming,
    };
  });

  return data;
}

/**
 * Identify render-blocking resources using renderBlockingStatus + heuristic fallback.
 *
 * When the API provides renderBlockingStatus (Chromium-based browsers), trust it directly.
 * Heuristic fallback only applies when the API field is unavailable (undefined), with
 * exclusions for font files (font-display: swap), preload hints, and async scripts.
 */
function identifyRenderBlocking(resources, fcpTime) {
  const blocking = [];
  const fontExtensions = ['.woff2', '.woff', '.ttf', '.otf', '.eot'];

  for (const r of resources) {
    // When the API provides a definitive status, trust it
    if (r.renderBlockingStatus !== undefined) {
      if (r.renderBlockingStatus === 'blocking') {
        blocking.push({
          url: r.name,
          type: r.initiatorType,
          transferSize: r.transferSize,
          duration: r.duration,
          detectedBy: 'api',
        });
      }
      continue;
    }

    // Heuristic fallback: only when API status is unavailable
    if (!fcpTime) continue;

    // Skip font files — font-display: swap means they are not render-blocking
    const urlLower = r.name.toLowerCase();
    if (fontExtensions.some(ext => urlLower.endsWith(ext))) continue;

    // Only flag CSS from link initiator (stylesheets), skip preloaded non-CSS resources
    if (r.initiatorType === 'link' || r.initiatorType === 'css') {
      if (!urlLower.endsWith('.css')) continue;
      if (r.responseEnd < fcpTime) {
        blocking.push({
          url: r.name,
          type: r.initiatorType,
          transferSize: r.transferSize,
          duration: r.duration,
          detectedBy: 'heuristic',
        });
      }
    }
    // Scripts excluded from heuristic — cannot distinguish async vs sync from Resource Timing
  }

  return blocking;
}

/**
 * Phase 1b: Code coverage via CDP (requires separate page load).
 */
async function captureCoverage(context, url) {
  const page = await context.newPage();
  const cdp = await page.context().newCDPSession(page);

  // Start JS coverage
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.startPreciseCoverage', {
    callCount: false,
    detailed: true,
  });

  // Start CSS coverage
  await cdp.send('CSS.enable');
  await cdp.send('CSS.startRuleUsageTracking');

  // Navigate
  await page.goto(url, {
    waitUntil: 'load',
    timeout: PAGESPEED.capture.navigationTimeout,
  });
  await page.waitForTimeout(PAGESPEED.capture.settleTimeout);

  // Collect JS coverage
  const { result: jsCoverage } = await cdp.send('Profiler.takePreciseCoverage');
  await cdp.send('Profiler.stopPreciseCoverage');

  // Collect CSS coverage
  const { ruleUsage } = await cdp.send('CSS.stopRuleUsageTracking');

  const jsBundles = [];
  for (const script of jsCoverage) {
    if (!script.url || script.url.startsWith('data:')) continue;
    const totalBytes = script.functions.reduce((sum, fn) => {
      return sum + fn.ranges.reduce((s, r) => s + (r.endOffset - r.startOffset), 0);
    }, 0);
    // Estimate total script size from the max endOffset
    let scriptSize = 0;
    for (const fn of script.functions) {
      for (const range of fn.ranges) {
        if (range.endOffset > scriptSize) scriptSize = range.endOffset;
      }
    }
    const usedBytes = script.functions.reduce((sum, fn) => {
      return sum + fn.ranges.filter(r => r.count > 0).reduce((s, r) => s + (r.endOffset - r.startOffset), 0);
    }, 0);
    const unusedBytes = scriptSize - usedBytes;
    const unusedPercent = scriptSize > 0 ? Math.round((unusedBytes / scriptSize) * 100) : 0;

    if (scriptSize > 1024) { // Filter to >1KB
      jsBundles.push({
        url: script.url,
        totalBytes: scriptSize,
        usedBytes,
        unusedBytes,
        unusedPercent,
      });
    }
  }

  // CSS coverage summary
  const cssUsedRules = ruleUsage.filter(r => r.used).length;
  const cssTotalRules = ruleUsage.length;
  const cssUnusedPercent = cssTotalRules > 0
    ? Math.round(((cssTotalRules - cssUsedRules) / cssTotalRules) * 100)
    : 0;

  await page.close();

  return {
    jsBundles: jsBundles.sort((a, b) => b.unusedBytes - a.unusedBytes),
    css: { totalRules: cssTotalRules, usedRules: cssUsedRules, unusedPercent: cssUnusedPercent },
  };
}

/**
 * Phase 2: PSI API enrichment (optional).
 */
async function fetchPsiData(url, apiKey, strategy) {
  const params = new URLSearchParams({
    url,
    key: apiKey,
    strategy,
    category: 'PERFORMANCE',
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PAGESPEED.psi.timeout);

  try {
    const response = await fetch(`${PAGESPEED.psi.apiBase}?${params}`, {
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`PSI API returned ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();
    const fieldData = {};
    const crux = data.loadingExperience?.metrics;

    if (crux) {
      if (crux.LARGEST_CONTENTFUL_PAINT_MS) {
        fieldData.lcp = crux.LARGEST_CONTENTFUL_PAINT_MS.percentile;
      }
      if (crux.CUMULATIVE_LAYOUT_SHIFT_SCORE) {
        fieldData.cls = crux.CUMULATIVE_LAYOUT_SHIFT_SCORE.percentile / 100;
      }
      if (crux.INTERACTION_TO_NEXT_PAINT) {
        fieldData.inp = crux.INTERACTION_TO_NEXT_PAINT.percentile;
      }
      if (crux.EXPERIMENTAL_TIME_TO_FIRST_BYTE) {
        fieldData.ttfb = crux.EXPERIMENTAL_TIME_TO_FIRST_BYTE.percentile;
      }
    }

    // Extract diagnostics from Lighthouse result
    const audits = data.lighthouseResult?.audits || {};
    const diagnostics = {};

    if (audits['critical-request-chains']?.details) {
      const chains = audits['critical-request-chains'].details.chains || {};
      let maxDepth = 0;
      function walkChain(node, depth) {
        if (depth > maxDepth) maxDepth = depth;
        if (node.children) {
          for (const child of Object.values(node.children)) {
            walkChain(child, depth + 1);
          }
        }
      }
      for (const chain of Object.values(chains)) {
        walkChain(chain, 1);
      }
      diagnostics.criticalChainDepth = maxDepth;
      diagnostics.criticalChainCount = Object.keys(chains).length;
    }

    if (audits['third-party-summary']?.details?.items) {
      diagnostics.thirdPartySummary = audits['third-party-summary'].details.items.map(item => ({
        entity: item.entity,
        transferSize: item.transferSize,
        mainThreadTime: item.mainThreadTime,
      }));
    }

    if (audits['mainthread-work-breakdown']?.details?.items) {
      diagnostics.mainThreadBreakdown = audits['mainthread-work-breakdown'].details.items
        .slice(0, 8)
        .map(item => ({
          group: item.groupLabel || item.group,
          duration: Math.round(item.duration),
        }));
    }

    if (audits['bootup-time']?.details?.items) {
      diagnostics.bootupTime = audits['bootup-time'].details.items
        .slice(0, 5)
        .map(item => ({
          url: item.url,
          total: Math.round(item.total),
          scripting: Math.round(item.scripting || 0),
        }));
    }

    return { fieldData, diagnostics, hasFieldData: Object.keys(fieldData).length > 0 };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Phase 3: Assemble results into standard runner output.
 */
function assembleResults(perfData, renderBlocking, coverage, psiResult) {
  const { observerData, resources, navigationTiming } = perfData;
  const { longTasks, layoutShifts, lcpEntry, fcpTime } = observerData;
  const T = PAGESPEED.thresholds;

  // Calculate metrics
  const lcpMs = lcpEntry ? Math.round(lcpEntry.startTime) : null;
  const fcpMs = fcpTime ? Math.round(fcpTime) : null;

  // Total Blocking Time (sum of long task time beyond 50ms threshold)
  const tbt = Math.round(longTasks.reduce((sum, t) => {
    return sum + Math.max(0, t.duration - PAGESPEED.capture.longTaskThreshold);
  }, 0));

  // CLS
  const cls = parseFloat(layoutShifts.reduce((sum, s) => sum + s.value, 0).toFixed(3));

  // Longest task
  const longestTask = longTasks.length > 0
    ? Math.round(Math.max(...longTasks.map(t => t.duration)))
    : 0;

  // Total render-blocking time
  const renderBlockingTime = Math.round(
    renderBlocking.reduce((sum, r) => sum + r.duration, 0)
  );

  // Total page weight (KB)
  const totalPageWeight = Math.round(
    resources.reduce((sum, r) => sum + r.transferSize, 0) / 1024
  );

  // Unused JS percentage (from coverage, or 0 if no coverage)
  let unusedJsPercent = 0;
  if (coverage && coverage.jsBundles.length > 0) {
    const totalJs = coverage.jsBundles.reduce((s, b) => s + b.totalBytes, 0);
    const unusedJs = coverage.jsBundles.reduce((s, b) => s + b.unusedBytes, 0);
    unusedJsPercent = totalJs > 0 ? Math.round((unusedJs / totalJs) * 100) : 0;
  }

  // Critical chain depth from PSI or estimate from resources
  const criticalChainDepth = psiResult?.diagnostics?.criticalChainDepth || 0;

  // Build checks
  const checks = [];

  // Core Web Vitals
  if (lcpMs !== null) {
    checks.push(makeCheck('LCP', lcpMs, T.lcp, 'ms', true, 'coreWebVitals'));
  }
  checks.push(makeCheck('CLS', cls, T.cls, '', true, 'coreWebVitals'));
  if (fcpMs !== null) {
    checks.push(makeCheck('FCP', fcpMs, T.fcp, 'ms', true, 'coreWebVitals'));
  }

  // Main Thread
  checks.push(makeCheck('Total Blocking Time', tbt, T.tbt, 'ms', true, 'mainThread'));
  checks.push(makeCheck('Long tasks during load', longTasks.length, T.longTaskCount, '', true, 'mainThread'));
  checks.push(makeCheck('Longest task duration', longestTask, T.longestTask, 'ms', true, 'mainThread'));

  // Render Blocking
  checks.push(makeCheck('Render-blocking resources', renderBlocking.length, T.renderBlockingCount, '', true, 'renderBlocking'));
  checks.push(makeCheck('Render-blocking time', renderBlockingTime, T.renderBlockingTime, 'ms', true, 'renderBlocking'));

  // Layout Stability
  // CLS already covered in core web vitals — add shift source count as informational

  // Resource Efficiency
  checks.push(makeCheck('Total page weight', totalPageWeight, T.totalPageWeight, 'KB', true, 'resourceEfficiency'));
  if (coverage) {
    checks.push(makeCheck('Unused JS', unusedJsPercent, T.unusedJs, '%', true, 'resourceEfficiency'));
  }

  // Critical Path
  if (criticalChainDepth > 0) {
    checks.push(makeCheck('Critical chain depth', criticalChainDepth, T.criticalChainDepth, ' levels', true, 'criticalPath'));
  }

  const failCount = checks.filter(c => !c.passed).length;
  const warnings = [];

  // PSI field data warnings
  if (psiResult && !psiResult.hasFieldData) {
    warnings.push('PSI API returned no CrUX field data — URL may not have enough real-user traffic');
  }

  // Layout shift sources for display
  const shiftSources = layoutShifts
    .flatMap(s => s.sources)
    .filter(s => s.selector);

  return {
    passed: failCount === 0,
    failCount,
    data: {
      navigationTiming,
      lcp: lcpEntry,
      fcp: fcpMs,
      cls,
      tbt,
      longTasks,
      layoutShifts,
      shiftSources,
      renderBlocking,
      resources,
      totalPageWeight,
      coverage: coverage || null,
      psi: psiResult || null,
    },
    checks,
    warnings,
    manualChecks: PAGESPEED.manualChecks,
  };
}

/**
 * Run a single-strategy pagespeed audit (mobile or desktop).
 */
async function runSingleStrategy({ url, authCookieObjects, strategy, options }) {
  const strategyConfig = PAGESPEED.strategies[strategy];
  const browser = await chromium.launch({ headless: true });

  const contextOptions = {
    viewport: strategyConfig.viewport,
    deviceScaleFactor: strategyConfig.deviceScaleFactor,
    isMobile: strategyConfig.isMobile,
    hasTouch: strategyConfig.hasTouch,
  };
  if (strategyConfig.userAgent) {
    contextOptions.userAgent = strategyConfig.userAgent;
  }

  const context = await browser.newContext(contextOptions);

  if (authCookieObjects) {
    await context.addCookies(authCookieObjects);
  }

  try {
    // Phase 1: Playwright performance capture
    const page = await context.newPage();
    const perfData = await capturePerformanceData(
      page,
      url,
      PAGESPEED.capture.settleTimeout,
    );
    await page.close();

    // Identify render-blocking resources
    const renderBlocking = identifyRenderBlocking(
      perfData.resources,
      perfData.observerData.fcpTime,
    );

    // Phase 1b: Code coverage (separate page load)
    let coverage = null;
    if (options.detailed !== false) {
      try {
        coverage = await captureCoverage(context, url);
      } catch (err) {
        // Coverage failure is non-fatal
        console.error(`  ⚠️  Coverage collection failed: ${err.message}`);
      }
    }

    // Phase 2: PSI API enrichment (optional)
    let psiResult = null;
    if (options.apiKey) {
      try {
        psiResult = await fetchPsiData(url, options.apiKey, strategy);
      } catch (err) {
        console.error(`  ⚠️  PSI API request failed: ${err.message}`);
      }
    }

    // Phase 3: Assemble results
    return assembleResults(perfData, renderBlocking, coverage, psiResult);
  } finally {
    await browser.close();
  }
}

/**
 * @param {object} opts
 * @param {string} opts.url
 * @param {import('playwright').Cookie[]} [opts.authCookieObjects]
 * @param {object} [opts.options]
 * @param {string} [opts.options.apiKey] - Google PSI API key
 * @param {string} [opts.options.strategy] - mobile/desktop/both (default: both)
 * @param {boolean} [opts.options.detailed] - Enable code coverage (default: true)
 * @returns {Promise<RunnerResult>}
 */
export async function runPagespeedAudit({ url, authCookieObjects, options = {} }) {
  const strategy = options.strategy || 'both';
  const strategies = strategy === 'both' ? ['mobile', 'desktop'] : [strategy];

  const strategyResults = {};
  const allChecks = [];
  const allWarnings = [];

  for (const s of strategies) {
    const result = await runSingleStrategy({
      url,
      authCookieObjects,
      strategy: s,
      options: { detailed: options.detailed, apiKey: options.apiKey },
    });
    strategyResults[s] = result;
    allChecks.push(...result.checks);
    allWarnings.push(...result.warnings);
  }

  const failCount = allChecks.filter(c => !c.passed).length;

  return {
    passed: failCount === 0,
    failCount,
    data: strategyResults,
    checks: allChecks,
    warnings: allWarnings,
    manualChecks: PAGESPEED.manualChecks,
  };
}
