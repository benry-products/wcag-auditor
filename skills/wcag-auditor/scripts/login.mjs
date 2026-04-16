#!/usr/bin/env node
/**
 * login.mjs - interactive login to capture Playwright storageState
 *
 * Launches a headed Chromium window at --url, waits for the user to complete
 * login (including any MFA) and press Enter in the terminal, then saves the
 * session state (cookies + localStorage) to --out.
 *
 * The resulting file contains live credentials and MUST be gitignored.
 *
 * Usage:
 *   node login.mjs --url https://app.example.com/login --out ./auth.json
 */

import { chromium } from 'playwright';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { printVersionBanner } from './lib/version.mjs';
import { checkForUpdates } from './lib/version-check.mjs';

const EXIT_OK = 0;
const EXIT_SCRIPT_ERROR = 2;

function parseCliArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      url: { type: 'string' },
      out: { type: 'string', default: './auth.json' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false,
    strict: true,
  });

  if (values.help) {
    printHelp();
    process.exit(EXIT_OK);
  }

  if (!values.url) {
    process.stderr.write('login.mjs: --url is required\n');
    process.exit(EXIT_SCRIPT_ERROR);
  }

  return {
    url: values.url,
    out: resolve(values.out),
  };
}

function printHelp() {
  process.stdout.write(`login.mjs - capture Playwright storageState for authenticated audits

Usage:
  node login.mjs --url <login-url> [--out ./auth.json]

Options:
  --url <url>   Login page URL (required)
  --out <path>  Where to save storageState JSON (default: ./auth.json)
  -h, --help    Show this help

The script:
  1. Opens a headed Chromium window at --url
  2. You complete login manually (including MFA)
  3. When logged in, return to this terminal and press Enter
  4. storageState (cookies + localStorage) is saved to --out

SECURITY: the output file contains live session credentials.
Add it to .gitignore. Never commit it.
`);
}

async function main() {
  printVersionBanner('login.mjs');
  const opts = parseCliArgs(process.argv.slice(2));
  await checkForUpdates();

  process.stdout.write(
    `\nlogin.mjs: opening ${opts.url} in a headed browser...\n`,
  );

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto(opts.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  } catch (err) {
    await browser.close();
    process.stderr.write(`login.mjs: failed to load ${opts.url}: ${err.message}\n`);
    process.exit(EXIT_SCRIPT_ERROR);
  }

  process.stdout.write(
    '\n1. Complete login in the browser window (including MFA).\n' +
      '2. Navigate to any post-login page to confirm you are signed in.\n' +
      '3. Return here and press Enter to save the session.\n\n',
  );

  const rl = createInterface({ input, output });
  try {
    await rl.question('Press Enter when logged in (or Ctrl+C to cancel)... ');
  } finally {
    rl.close();
  }

  try {
    await context.storageState({ path: opts.out });
  } catch (err) {
    await browser.close();
    process.stderr.write(`login.mjs: failed to save storageState: ${err.message}\n`);
    process.exit(EXIT_SCRIPT_ERROR);
  }

  await browser.close();
  process.stdout.write(`\nlogin.mjs: storageState saved to ${opts.out}\n`);
  process.stdout.write(
    'Pass this file to audit.mjs / audit-site.mjs via --auth.\n' +
      'REMEMBER: this file contains live credentials. Do not commit it.\n\n',
  );
  process.exit(EXIT_OK);
}

main();
