#!/usr/bin/env node
/**
 * audit-site.mjs - multi-URL WCAG audit
 *
 * Unions URLs from --sitemap + --urls + --crawl-from, applies include/exclude
 * globs, audits each URL at configured viewports and concurrency, writes
 * per-URL JSON files plus aggregated.json and urls.resolved.txt.
 */

import { chromium } from 'playwright';
import { writeFile, access, mkdir } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
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
import { resolveUrls } from './lib/url-sources.mjs';

function parseCliArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      sitemap: { type: 'string' },
      urls: { type: 'string' },
      'crawl-from': { type: 'string' },
      depth: { type: 'string', default: '1' },
      include: { type: 'string', multiple: true },
      exclude: { type: 'string', multiple: true },
      auth: { type: 'string' },
      level: { type: 'string', default: 'AA' },
      viewport: { type: 'string', multiple: true },
      concurrency: { type: 'string', default: '1' },
      'include-best-practice': { type: 'boolean', default: false },
      out: { type: 'string', default: './wcag-audit' },
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

  if (!values.sitemap && !values.urls && !values['crawl-from']) {
    fail('at least one URL source required: --sitemap, --urls, or --crawl-from');
  }

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

  const concurrency = Number.parseInt(values.concurrency, 10);
  if (!Number.isFinite(concurrency) || concurrency < 1) {
    fail(`--concurrency must be a positive integer (got: ${values.concurrency})`);
  }

  const depth = Number.parseInt(values.depth, 10);
  if (!Number.isFinite(depth) || depth < 0) {
    fail(`--depth must be a non-negative integer (got: ${values.depth})`);
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

  return {
    sitemap: values.sitemap,
    urlsFile: values.urls,
    crawlFrom: values['crawl-from'],
    depth,
    includes: values.include ?? [],
    excludes: values.exclude ?? [],
    authPath: values.auth,
    level,
    viewports,
    concurrency,
    includeBestPractice: values['include-best-practice'],
    outDir: resolve(values.out),
    failOn,
  };
}

function printHelp() {
  process.stdout.write(`audit-site.mjs - multi-URL WCAG audit

Usage:
  node audit-site.mjs [URL sources] [options]

URL sources (one or more required, unioned + deduped):
  --sitemap <url>          XML sitemap URL
  --urls <path>            newline-delimited file (# comments supported)
  --crawl-from <url>       seed URL for bounded same-origin crawl
    --depth <n>            crawl depth (default: 1)

Filters (applied to union):
  --include <glob>         repeatable; URL must match at least one if provided
  --exclude <glob>         repeatable; URL must match none

Audit options:
  --auth <path>            Playwright storageState (for authenticated routes)
  --level AA|AAA           WCAG level (default: AA)
  --viewport <WxH>         repeatable (default: 1280x800 and 375x667)
  --concurrency <n>        parallel audits (default: 1)
  --include-best-practice  include axe best-practice rules
  --out <dir>              output directory (default: ./wcag-audit)
  --fail-on <level>        none|minor|moderate|serious|critical|any (default: none)
  -h, --help               show this help

Output files:
  <out>/urls.resolved.txt   unioned URL list actually audited
  <out>/<hash>.json         per-URL audit report
  <out>/aggregated.json     deduped cross-URL rollup
`);
}

function fail(msg) {
  process.stderr.write(`audit-site.mjs: ${msg}\n`);
  process.exit(EXIT_SCRIPT_ERROR);
}

function urlHash(url) {
  return createHash('sha1').update(url).digest('hex').slice(0, 12);
}

async function runWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  async function runNext() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  }

  const workers = [];
  for (let i = 0; i < Math.min(concurrency, items.length); i++) {
    workers.push(runNext());
  }
  await Promise.all(workers);
  return results;
}

function aggregate(perUrlReports) {
  // Key violations by (ruleId, target[0], url) so we can show cross-URL impact.
  const byRule = new Map();
  let totalIncomplete = 0;

  for (const report of perUrlReports) {
    if (report.error) continue;
    totalIncomplete += report.incomplete.length;
    for (const v of report.violations) {
      let entry = byRule.get(v.id);
      if (!entry) {
        entry = {
          id: v.id,
          impact: v.impact,
          tags: v.tags,
          description: v.description,
          help: v.help,
          helpUrl: v.helpUrl,
          urls: [],
          totalNodes: 0,
        };
        byRule.set(v.id, entry);
      }
      entry.urls.push({
        url: report.url,
        nodeCount: v.nodes.length,
        nodes: v.nodes,
      });
      entry.totalNodes += v.nodes.length;
    }
  }

  return {
    violations: [...byRule.values()].sort((a, b) => {
      // Sort by impact severity then rule id
      const impacts = { critical: 0, serious: 1, moderate: 2, minor: 3 };
      const ai = impacts[a.impact] ?? 99;
      const bi = impacts[b.impact] ?? 99;
      if (ai !== bi) return ai - bi;
      return a.id.localeCompare(b.id);
    }),
    totalIncomplete,
  };
}

async function main() {
  const opts = parseCliArgs(process.argv.slice(2));

  let storageState;
  if (opts.authPath) {
    try {
      await access(opts.authPath, fsConstants.R_OK);
      storageState = opts.authPath;
    } catch {
      fail(`--auth file not readable: ${opts.authPath}`);
    }
  }

  // 1. Resolve URL set
  process.stderr.write('audit-site: resolving URLs...\n');
  let urls;
  try {
    urls = await resolveUrls({
      sitemap: opts.sitemap,
      urlsFile: opts.urlsFile,
      crawlFrom: opts.crawlFrom,
      crawlDepth: opts.depth,
      includes: opts.includes,
      excludes: opts.excludes,
      storageState,
    });
  } catch (err) {
    fail(`URL resolution failed: ${err.message}`);
  }

  if (urls.length === 0) {
    fail('no URLs to audit after applying sources and filters');
  }

  // 2. Prepare output dir + write urls.resolved.txt
  try {
    await mkdir(opts.outDir, { recursive: true });
  } catch (err) {
    fail(`failed to create output dir ${opts.outDir}: ${err.message}`);
  }

  const urlsResolvedPath = join(opts.outDir, 'urls.resolved.txt');
  await writeFile(urlsResolvedPath, urls.join('\n') + '\n', 'utf8');
  process.stderr.write(`audit-site: ${urls.length} URL(s) resolved -> ${urlsResolvedPath}\n`);

  // 3. Audit
  const axeTags = axeTagsFor(opts.level, opts.includeBestPractice);
  const browser = await chromium.launch();

  const perUrlReports = [];
  try {
    const results = await runWithConcurrency(urls, opts.concurrency, async (url, i) => {
      process.stderr.write(`audit-site: [${i + 1}/${urls.length}] ${url}\n`);
      try {
        const result = await auditUrl({
          browser,
          url,
          viewports: opts.viewports,
          axeTags,
          storageState,
        });
        const report = {
          ...result,
          level: opts.level,
          includeBestPractice: opts.includeBestPractice,
          axeTags,
        };
        const perUrlPath = join(opts.outDir, `${urlHash(url)}.json`);
        await writeFile(perUrlPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
        return report;
      } catch (err) {
        process.stderr.write(`audit-site: ERROR ${url}: ${err.message}\n`);
        return { url, error: err.message, violations: [], incomplete: [] };
      }
    });
    perUrlReports.push(...results);
  } finally {
    await browser.close();
  }

  // 4. Aggregate
  const agg = aggregate(perUrlReports);
  const aggregated = {
    startedAt: perUrlReports[0]?.startedAt,
    finishedAt: new Date().toISOString(),
    level: opts.level,
    includeBestPractice: opts.includeBestPractice,
    axeTags,
    viewports: opts.viewports.map((v) => v.label),
    urlCount: urls.length,
    errorCount: perUrlReports.filter((r) => r.error).length,
    totalIncomplete: agg.totalIncomplete,
    violations: agg.violations,
  };

  const aggregatedPath = join(opts.outDir, 'aggregated.json');
  await writeFile(aggregatedPath, JSON.stringify(aggregated, null, 2) + '\n', 'utf8');

  const totalViolationInstances = aggregated.violations.reduce(
    (s, v) => s + v.totalNodes,
    0,
  );
  process.stderr.write(
    `audit-site: ${aggregated.violations.length} unique rule(s), ${totalViolationInstances} instance(s) across ${urls.length} URL(s) -> ${aggregatedPath}\n`,
  );
  if (aggregated.errorCount > 0) {
    process.stderr.write(`audit-site: ${aggregated.errorCount} URL(s) failed to audit\n`);
  }

  // 5. Threshold check (flatten all violations across URLs)
  const flat = aggregated.violations.flatMap((v) =>
    v.urls.map(() => ({ impact: v.impact })),
  );
  if (thresholdCrossed(flat, opts.failOn)) {
    process.exit(EXIT_THRESHOLD_CROSSED);
  }
  if (aggregated.errorCount > 0 && aggregated.violations.length === 0) {
    // If all URLs errored, that's a script-level failure
    if (aggregated.errorCount === urls.length) {
      process.exit(EXIT_SCRIPT_ERROR);
    }
  }
  process.exit(EXIT_OK);
}

main();
