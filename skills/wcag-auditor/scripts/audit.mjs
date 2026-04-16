#!/usr/bin/env node
/**
 * audit.mjs - single-URL WCAG audit
 *
 * Runs axe-core via Playwright against one URL at one or more viewports,
 * merges results, writes per-URL JSON, and implements the exit code contract.
 */

import { chromium } from 'playwright';
import { writeFile, access, mkdir } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { parseArgs } from 'node:util';
import {
  EXIT_OK,
  EXIT_THRESHOLD_CROSSED,
  EXIT_SCRIPT_ERROR,
  VALID_FAIL_ON,
  DEFAULT_VIEWPORTS,
  parseViewport,
  axeTagsFor,
  auditUrl,
  thresholdCrossed,
} from './lib/audit-core.mjs';
import { printVersionBanner } from './lib/version.mjs';
import { checkForUpdates } from './lib/version-check.mjs';

function parseCliArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      url: { type: 'string' },
      auth: { type: 'string' },
      level: { type: 'string', default: 'AA' },
      viewport: { type: 'string', multiple: true },
      'include-best-practice': { type: 'boolean', default: false },
      out: { type: 'string' },
      'fail-on': { type: 'string', default: 'none' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false,
    strict: true,
  });

  if (values.help) {
    printHelp();
    process.exit(EXIT_OK);
  }

  if (!values.url) fail('--url is required');

  const level = values.level.toUpperCase();
  if (level !== 'AA' && level !== 'AAA') {
    fail(`--level must be AA or AAA (got: ${values.level})`);
  }

  const failOn = values['fail-on'].toLowerCase();
  if (!VALID_FAIL_ON.has(failOn)) {
    fail(
      `--fail-on must be one of: ${[...VALID_FAIL_ON].join(', ')} (got: ${values['fail-on']})`,
    );
  }

  let viewports;
  try {
    viewports = (values.viewport && values.viewport.length > 0
      ? values.viewport
      : DEFAULT_VIEWPORTS
    ).map(parseViewport);
  } catch (err) {
    fail(err.message);
  }

  const out =
    values.out ??
    `./wcag-audit/audit-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;

  return {
    url: values.url,
    authPath: values.auth,
    level,
    viewports,
    includeBestPractice: values['include-best-practice'],
    out: resolve(out),
    failOn,
  };
}

function printHelp() {
  process.stdout.write(`audit.mjs - single-URL WCAG audit

Usage:
  node audit.mjs --url <url> [options]

Options:
  --url <url>              Target URL (required)
  --auth <path>            Playwright storageState JSON (for authenticated routes)
  --level AA|AAA           WCAG level (default: AA)
  --viewport <WxH>         Viewport (repeatable; default: 1280x800 and 375x667)
  --include-best-practice  Include axe best-practice rules (non-normative)
  --out <path>             Output JSON path (default: ./wcag-audit/audit-<timestamp>.json)
  --fail-on <level>        Exit 1 if any violation impact >= <level>.
                           One of: none, minor, moderate, serious, critical, any
                           Default: none
  -h, --help               Show this help

Exit codes:
  0  success; --fail-on threshold not crossed
  1  success; threshold crossed (a11y gate failed)
  2  script error (network, bad URL, expired auth, axe crash)
`);
}

function fail(msg) {
  process.stderr.write(`audit.mjs: ${msg}\n`);
  process.exit(EXIT_SCRIPT_ERROR);
}

async function main() {
  printVersionBanner('audit.mjs');
  const opts = parseCliArgs(process.argv.slice(2));
  await checkForUpdates();

  let storageState;
  if (opts.authPath) {
    try {
      await access(opts.authPath, fsConstants.R_OK);
      storageState = opts.authPath;
    } catch {
      fail(`--auth file not readable: ${opts.authPath}`);
    }
  }

  const axeTags = axeTagsFor(opts.level, opts.includeBestPractice);

  const browser = await chromium.launch();
  let result;
  try {
    result = await auditUrl({
      browser,
      url: opts.url,
      viewports: opts.viewports,
      axeTags,
      storageState,
    });
  } catch (err) {
    await browser.close();
    process.stderr.write(`audit.mjs: ${err.message}\n`);
    process.exit(EXIT_SCRIPT_ERROR);
  }
  await browser.close();

  const report = {
    ...result,
    level: opts.level,
    includeBestPractice: opts.includeBestPractice,
    axeTags,
  };

  try {
    await mkdir(dirname(opts.out), { recursive: true });
    await writeFile(opts.out, JSON.stringify(report, null, 2) + '\n', 'utf8');
  } catch (err) {
    fail(`failed to write ${opts.out}: ${err.message}`);
  }

  process.stderr.write(
    `audit: ${report.violations.length} violation(s), ${report.incomplete.length} incomplete - ${opts.out}\n`,
  );

  if (thresholdCrossed(report.violations, opts.failOn)) {
    process.exit(EXIT_THRESHOLD_CROSSED);
  }
  process.exit(EXIT_OK);
}

main();
