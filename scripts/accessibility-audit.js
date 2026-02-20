#!/usr/bin/env node

/**
 * Accessibility Audit
 * ───────────────────
 * Runs axe-core against a page via Playwright to check WCAG 2.1 AA compliance.
 *
 * Covers PR checklist section:
 *   §7 — Accessibility (WCAG 2.1 AA)
 *     - Keyboard navigation
 *     - Focus indicators
 *     - Colour contrast (4.5:1 text, 3:1 large text/UI)
 *     - Accessible names (aria-labels)
 *     - No content conveyed by colour alone
 *
 * Usage:
 *   node scripts/accessibility-audit.js https://preview-url.vercel.app
 *   node scripts/accessibility-audit.js https://preview-url.vercel.app --password mypass
 *   node scripts/accessibility-audit.js https://preview-url.vercel.app --tags wcag2aa
 */

import { chromium } from 'playwright';
import { createCLI, resolveArgs } from '../lib/cli.js';
import { ACCESSIBILITY } from '../lib/config.js';
import { vercelAuth } from '../lib/vercel-auth.js';
import {
  heading, subheading, fail, warn, info,
  printChecks, saveReport, buildSummary
} from '../lib/report.js';
import { runAccessibilityAudit } from '../lib/runners/accessibility.js';

// ── CLI Setup ──────────────────────────────────────────────
const program = createCLI(
  'accessibility-audit',
  'Run axe-core WCAG 2.1 AA accessibility audit'
);

program
  .option('--tags <tags>', 'axe-core tags to check (comma-separated)', 'wcag2a,wcag2aa,wcag21a,wcag21aa')
  .option('--include <selector>', 'CSS selector to scope the audit to')
  .option('--exclude <selector>', 'CSS selector to exclude from audit')
  .option('--summary-only', 'Only show violation counts, not details')
  .parse(process.argv);

const args = resolveArgs(program);

// ── Main ───────────────────────────────────────────────────
async function run() {
  heading(`Accessibility Audit: ${args.url}`);
  info(`Standard: WCAG 2.1 AA (axe-core tags: ${args.tags})`);

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

  info('Running axe-core scan...');

  const result = await runAccessibilityAudit({
    url: args.url,
    authCookieObjects,
    options: {
      tags: args.tags.split(',').map(t => t.trim()),
      include: args.include,
      exclude: args.exclude,
    },
  });

  const { data } = result;
  const { summary, violations } = data;

  // ── Results Summary ──────────────────────────────────────
  subheading('Results');
  printChecks(result.checks.filter(c => c.label === 'axe-core scan'));

  if (summary.totalViolations > 0) {
    console.log('');
    if (summary.bySeverity.critical > 0) fail(`Critical: ${summary.bySeverity.critical}`);
    if (summary.bySeverity.serious > 0)  fail(`Serious:  ${summary.bySeverity.serious}`);
    if (summary.bySeverity.moderate > 0) warn(`Moderate: ${summary.bySeverity.moderate}`);
    if (summary.bySeverity.minor > 0)    info(`Minor:    ${summary.bySeverity.minor}`);
  }

  // ── Detailed Violations ──────────────────────────────────
  if (violations.length > 0 && !args.summaryOnly) {
    subheading('Violation Details');

    violations.forEach((v, i) => {
      const impactIcon = v.impact === 'critical' || v.impact === 'serious' ? '❌' : '⚠️';
      console.log(`\n  ${impactIcon} ${i + 1}. [${v.impact.toUpperCase()}] ${v.help}`);
      console.log(`     Rule: ${v.id}`);
      console.log(`     WCAG: ${v.wcagTags.join(', ')}`);
      console.log(`     Help: ${v.helpUrl}`);
      console.log(`     Affected elements (${v.nodeCount}):`);

      v.nodes.slice(0, ACCESSIBILITY.display.violationNodeLimit).forEach(node => {
        const selector = node.target.join(' > ');
        console.log(`       • ${selector}`);
        if (node.failureSummary) {
          console.log(`         ${node.failureSummary.split('\n')[0]}`);
        }
      });

      if (v.nodeCount > ACCESSIBILITY.display.violationNodeLimit) {
        console.log(`       ... and ${v.nodeCount - ACCESSIBILITY.display.violationNodeLimit} more elements`);
      }
    });
  }

  // ── Checklist Mapping ────────────────────────────────────
  subheading('Checklist §7 Coverage');
  printChecks(result.checks.filter(c => c.label !== 'axe-core scan'));

  for (const mc of result.manualChecks) warn(mc);

  // ── Incomplete (needs manual review) ─────────────────────
  if (data.incompleteItems.length > 0) {
    subheading(`Manual Review Needed (${data.incompleteItems.length} items)`);
    data.incompleteItems.slice(0, ACCESSIBILITY.display.incompleteLimit).forEach(item => {
      console.log(`  ⚠️  ${item.help} (${item.nodeCount} elements)`);
    });
    if (data.incompleteItems.length > ACCESSIBILITY.display.incompleteLimit) {
      console.log(`  ... and ${data.incompleteItems.length - ACCESSIBILITY.display.incompleteLimit} more (see full report)`);
    }
  }

  // Save report
  if (args.save) {
    const reportData = buildSummary('accessibility', args.url, data);
    const filepath = saveReport('accessibility', reportData);
    console.log(`\n  📄 Full report saved: ${filepath}`);
  }

  // Exit code
  if (!result.passed) {
    heading('Result: FAIL — critical/serious accessibility violations found');
    process.exit(1);
  } else if (summary.totalViolations > 0) {
    heading('Result: WARN — minor/moderate violations found');
    process.exit(0);
  } else {
    heading('Result: PASS');
    process.exit(0);
  }
}

run().catch(err => {
  console.error('\n❌ Accessibility audit failed:', err.message);
  process.exit(2);
});
