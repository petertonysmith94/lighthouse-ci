/**
 * Breakpoints Runner
 * ──────────────────
 * Uses Playwright to capture screenshots at all spec breakpoints
 * across browsers. Checks for horizontal overflow and CLS risks.
 * Covers §2 — Responsive & Cross-Browser.
 */

import { chromium, webkit, firefox } from 'playwright';
import { mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { BREAKPOINTS, BREAKPOINT_TEST } from '../config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCREENSHOTS_DIR = join(__dirname, '..', '..', 'reports', 'screenshots');

const BROWSER_LAUNCHERS = { chromium, webkit, firefox };

/**
 * @param {object} opts
 * @param {string} opts.url
 * @param {import('playwright').Cookie[]} [opts.authCookieObjects]
 * @param {object} [opts.options] - { browsers, fullPage, checkOverflow }
 * @returns {Promise<RunnerResult>}
 */
export async function runBreakpointTest({ url, authCookieObjects = null, options = {} }) {
  const browsers = options.browsers || ['chromium', 'webkit'];
  const checkOverflow = options.checkOverflow !== false;
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const screenshotDir = join(SCREENSHOTS_DIR, timestamp);
  mkdirSync(screenshotDir, { recursive: true });

  const results = {};
  const checks = [];
  const warnings = [];
  let totalIssues = 0;

  for (const browserName of browsers) {
    const launcher = BROWSER_LAUNCHERS[browserName];
    if (!launcher) {
      warnings.push(`Unknown browser: ${browserName}, skipping`);
      continue;
    }

    const browser = await launcher.launch({ headless: true });
    results[browserName] = {};

    for (const bp of BREAKPOINTS) {
      const deviceProps = BREAKPOINT_TEST.devices[bp.name] || BREAKPOINT_TEST.devices.Desktop;
      const context = await browser.newContext({
        viewport: { width: bp.width, height: bp.height },
        deviceScaleFactor: deviceProps.deviceScaleFactor,
        isMobile: deviceProps.isMobile,
        hasTouch: deviceProps.hasTouch,
      });

      if (authCookieObjects) {
        await context.addCookies(authCookieObjects);
      }

      const page = await context.newPage();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: BREAKPOINT_TEST.navigationTimeout });
      await page.waitForTimeout(BREAKPOINT_TEST.settleTimeout);

      // Screenshot
      const screenshotPath = join(screenshotDir, `${browserName}_${bp.name}_${bp.width}px.png`);
      await page.screenshot({
        path: screenshotPath,
        fullPage: options.fullPage || false,
      });

      const bpResult = {
        breakpoint: bp.name,
        width: bp.width,
        screenshot: screenshotPath,
        issues: [],
      };

      // Horizontal overflow check
      if (checkOverflow) {
        const overflowData = await page.evaluate(([tolerance, scanLimit]) => {
          const body = document.body;
          const html = document.documentElement;
          const viewportWidth = window.innerWidth;
          const bodyScrollWidth = body.scrollWidth;
          const htmlScrollWidth = html.scrollWidth;
          const hasOverflow = bodyScrollWidth > viewportWidth || htmlScrollWidth > viewportWidth;

          const overflowing = [];
          if (hasOverflow) {
            const allElements = document.querySelectorAll('body *');
            for (const el of allElements) {
              const rect = el.getBoundingClientRect();
              if (rect.right > viewportWidth + tolerance) {
                overflowing.push({
                  tag: el.tagName.toLowerCase(),
                  class: el.className?.toString().slice(0, 80) || '',
                  id: el.id || '',
                  right: Math.round(rect.right),
                  overflow: Math.round(rect.right - viewportWidth),
                });
                if (overflowing.length >= scanLimit) break;
              }
            }
          }

          return { viewportWidth, bodyScrollWidth, htmlScrollWidth, hasOverflow, overflowing };
        }, [BREAKPOINT_TEST.overflowTolerance, BREAKPOINT_TEST.overflowScanLimit]);

        if (overflowData.hasOverflow) {
          const overflowPx = Math.max(
            overflowData.bodyScrollWidth - overflowData.viewportWidth,
            overflowData.htmlScrollWidth - overflowData.viewportWidth
          );
          bpResult.issues.push({
            type: 'horizontal-overflow',
            message: `Page overflows by ${overflowPx}px at ${bp.width}px viewport`,
            elements: overflowData.overflowing,
          });
          checks.push({
            label: `${bp.name} (${bp.width}px) overflow`,
            passed: false,
            message: `${bp.name} (${bp.width}px): Horizontal overflow by ${overflowPx}px`,
            overflowing: overflowData.overflowing,
          });
          totalIssues++;
        } else {
          checks.push({
            label: `${bp.name} (${bp.width}px) overflow`,
            passed: true,
            message: `${bp.name} (${bp.width}px): No horizontal overflow`,
          });
        }
      }

      // CLS risk — images without dimensions
      const mediaIssues = await page.evaluate(() => {
        const issues = [];
        const images = document.querySelectorAll('img');
        images.forEach(img => {
          if (!img.getAttribute('width') && !img.getAttribute('height') &&
              !img.style.width && !img.style.height &&
              !img.closest('[style*="aspect-ratio"]')) {
            const computed = getComputedStyle(img);
            if (computed.width === 'auto' || computed.height === 'auto') {
              issues.push({
                type: 'img-no-dimensions',
                src: img.src?.slice(0, 100),
                alt: img.alt?.slice(0, 50),
              });
            }
          }
        });
        return issues;
      });

      if (mediaIssues.length > 0) {
        bpResult.issues.push(...mediaIssues);
        warnings.push(`${bp.name}: ${mediaIssues.length} image(s) without explicit dimensions (CLS risk)`);
      }

      results[browserName][bp.name] = bpResult;
      await context.close();
    }

    await browser.close();
  }

  return {
    passed: totalIssues === 0,
    failCount: totalIssues,
    data: { results, screenshotDir },
    checks,
    warnings,
    manualChecks: BREAKPOINT_TEST.manualChecks,
  };
}
