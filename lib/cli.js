/**
 * Shared CLI argument parsing for all QA scripts.
 * Every script accepts at minimum a URL and optional Vercel password.
 */

import { Command } from 'commander';

/**
 * Create a base CLI program with shared options.
 * Individual scripts extend this with their own options.
 */
export function createCLI(name, description) {
  const program = new Command();

  program
    .name(name)
    .description(description)
    .argument('<url>', 'URL to audit (Vercel preview or production)')
    .option('-p, --password <password>', 'Vercel preview deployment password (or set VERCEL_PREVIEW_PASSWORD env var)')
    .option('--json', 'Output raw JSON instead of formatted report')
    .option('--save', 'Save report to ./reports/ directory', true)
    .option('--no-save', 'Do not save report file');

  return program;
}

/**
 * Extract the URL and resolved password from parsed CLI args.
 */
export function resolveArgs(program) {
  const opts = program.opts();
  const url = program.args[0];
  const password = opts.password || process.env.VERCEL_PREVIEW_PASSWORD || null;

  return { url, password, ...opts };
}
