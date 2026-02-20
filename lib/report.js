/**
 * Report utilities — consistent output formatting across all QA scripts.
 * Reports are saved as JSON to ./reports/ and printed as human-readable summaries.
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR = join(__dirname, '..', 'reports');

export function saveReport(name, data) {
  mkdirSync(REPORTS_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `${name}_${timestamp}.json`;
  const filepath = join(REPORTS_DIR, filename);
  writeFileSync(filepath, JSON.stringify(data, null, 2));
  return filepath;
}

export function pass(msg) {
  console.log(`  ✅ ${msg}`);
}

export function fail(msg) {
  console.log(`  ❌ ${msg}`);
}

export function warn(msg) {
  console.log(`  ⚠️  ${msg}`);
}

export function info(msg) {
  console.log(`  ℹ️  ${msg}`);
}

export function heading(msg) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  ${msg}`);
  console.log(`${'─'.repeat(60)}`);
}

export function subheading(msg) {
  console.log(`\n  ── ${msg} ──`);
}

/**
 * Print a pass/fail result against a threshold.
 */
export function checkThreshold(label, value, threshold, unit = '', lowerIsBetter = true) {
  const passed = lowerIsBetter ? value <= threshold : value >= threshold;
  const op = lowerIsBetter ? '≤' : '≥';
  const display = `${label}: ${value}${unit} (target: ${op} ${threshold}${unit})`;
  if (passed) {
    pass(display);
  } else {
    fail(display);
  }
  return passed;
}

/**
 * Print an array of Check objects ({ label, passed, value?, threshold?, unit?, message? }).
 * Each check is printed as a pass/fail line. Returns the number of failures.
 */
export function printChecks(checks) {
  let fails = 0;
  for (const c of checks) {
    if (c.passed) {
      if (c.threshold != null) {
        const op = c.lowerIsBetter === false ? '>=' : '<=';
        pass(`${c.label}: ${c.value}${c.unit || ''} (target: ${op} ${c.threshold}${c.unit || ''})`);
      } else {
        pass(c.message || c.label);
      }
    } else {
      if (c.threshold != null) {
        const op = c.lowerIsBetter === false ? '>=' : '<=';
        fail(`${c.label}: ${c.value}${c.unit || ''} (target: ${op} ${c.threshold}${c.unit || ''})`);
      } else {
        fail(c.message || c.label);
      }
      fails++;
    }
  }
  return fails;
}

/**
 * Generate a summary object for optional Claude analysis.
 */
export function buildSummary(toolName, url, results) {
  return {
    tool: toolName,
    url,
    timestamp: new Date().toISOString(),
    results,
  };
}
