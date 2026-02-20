/**
 * Accessibility Runner
 * ────────────────────
 * Runs axe-core via Playwright to check WCAG 2.1 AA compliance.
 * Covers §7 — Accessibility.
 */

import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { ACCESSIBILITY } from '../config.js';

/**
 * @param {object} opts
 * @param {string} opts.url
 * @param {import('playwright').Cookie[]} [opts.authCookieObjects]
 * @param {object} [opts.options] - { tags, include, exclude, summaryOnly }
 * @returns {Promise<RunnerResult>}
 */
export async function runAccessibilityAudit({ url, authCookieObjects, options = {} }) {
  const tags = options.tags || ACCESSIBILITY.defaultTags;

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();

  if (authCookieObjects) {
    await context.addCookies(authCookieObjects);
  }

  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(ACCESSIBILITY.settleTimeout);

  // Build axe configuration
  let axeBuilder = new AxeBuilder({ page }).withTags(tags);
  if (options.include) axeBuilder = axeBuilder.include(options.include);
  if (options.exclude) axeBuilder = axeBuilder.exclude(options.exclude);

  const axeResults = await axeBuilder.analyze();

  const violations = axeResults.violations;
  const passes = axeResults.passes.length;
  const incomplete = axeResults.incomplete.length;

  // Sort by severity
  violations.sort((a, b) =>
    (ACCESSIBILITY.impactOrder[a.impact] ?? 4) - (ACCESSIBILITY.impactOrder[b.impact] ?? 4)
  );

  // Count by severity
  const bySeverity = { critical: 0, serious: 0, moderate: 0, minor: 0 };
  violations.forEach(v => { bySeverity[v.impact] = (bySeverity[v.impact] || 0) + 1; });

  // Main pass/fail check
  const checks = [];
  if (violations.length === 0) {
    checks.push({ label: 'axe-core scan', passed: true, message: `No violations found (${passes} rules passed, ${incomplete} need manual review)` });
  } else {
    checks.push({ label: 'axe-core scan', passed: false, message: `${violations.length} violation(s) found (${passes} passed, ${incomplete} need manual review)` });
  }

  // Checklist mapping
  for (const [key, rule] of Object.entries(ACCESSIBILITY.checklist)) {
    const matched = violations.filter(rule.match);
    if (matched.length === 0) {
      checks.push({ label: rule.label, passed: true, message: rule.label });
    } else {
      const detail = key === 'contrast'
        ? `${rule.failLabel}: ${matched[0].nodes.length} element(s) fail AA minimums`
        : `${rule.failLabel}: ${matched.length} rule(s) failing`;
      checks.push({ label: rule.label, passed: false, message: detail });
    }
  }

  // Determine pass/fail: critical/serious = hard fail
  const hasCritical = bySeverity.critical > 0 || bySeverity.serious > 0;
  const failCount = hasCritical ? checks.filter(c => !c.passed).length : 0;

  await browser.close();

  return {
    passed: !hasCritical,
    failCount,
    data: {
      violations: violations.map(v => ({
        id: v.id,
        impact: v.impact,
        help: v.help,
        helpUrl: v.helpUrl,
        wcagTags: v.tags.filter(t => t.startsWith('wcag')),
        nodeCount: v.nodes.length,
        nodes: v.nodes.slice(0, 5).map(n => ({
          target: n.target,
          html: n.html?.slice(0, 200),
          failureSummary: n.failureSummary,
        })),
      })),
      summary: {
        totalViolations: violations.length,
        bySeverity,
        passes,
        incomplete,
      },
      incompleteItems: axeResults.incomplete.map(item => ({
        help: item.help,
        nodeCount: item.nodes.length,
      })),
    },
    checks,
    warnings: violations.length > 0 && !hasCritical
      ? [`${violations.length} minor/moderate violation(s) — non-blocking`]
      : [],
    manualChecks: ACCESSIBILITY.manualChecks,
  };
}
