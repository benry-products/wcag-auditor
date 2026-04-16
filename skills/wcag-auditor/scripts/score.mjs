#!/usr/bin/env node
/**
 * score.mjs - derive per-SC conformance classifications
 *
 * Reads aggregated.json (from audit-site.mjs) and produces a conformance
 * classification per WCAG success criterion:
 *   - supports
 *   - partially-supports
 *   - does-not-support
 *   - not-applicable
 *   - not-evaluated (SC requires manual verification, not performed)
 *
 * Output: JSON structure consumed by report-generate.mjs and vpat-fill.mjs.
 *
 * Usage:
 *   node score.mjs --aggregated <path> [--out <path>]
 */

import axeModule from 'axe-core';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { WCAG_SCS, filterByLevel, scTagFromAxe } from './lib/wcag-sc-list.mjs';
import { normalizeToAggregated } from './lib/normalize.mjs';

const axe = axeModule.default ?? axeModule;

const EXIT_OK = 0;
const EXIT_SCRIPT_ERROR = 2;

function parseCliArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      aggregated: { type: 'string' },
      out: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false,
    strict: true,
  });

  if (values.help) {
    printHelp();
    process.exit(EXIT_OK);
  }

  if (!values.aggregated) {
    fail('--aggregated is required');
  }

  return {
    aggregatedPath: resolve(values.aggregated),
    outPath: values.out ? resolve(values.out) : null,
  };
}

function printHelp() {
  process.stdout.write(`score.mjs - derive per-SC conformance

Usage:
  node score.mjs --aggregated <path> [--out <path>]

Options:
  --aggregated <path>  aggregated.json from audit-site.mjs,
                       OR a single-URL audit JSON from audit.mjs
                       (single-URL input is wrapped internally)
  --out <path>         write score JSON (default: stdout)
  -h, --help           show this help
`);
}

function fail(msg) {
  process.stderr.write(`score.mjs: ${msg}\n`);
  process.exit(EXIT_SCRIPT_ERROR);
}

/**
 * Build a map of axe rule id -> set of WCAG SC strings (e.g. '1.4.3').
 * Derived from axe-core's internal rule registry, so always in sync with
 * the installed axe-core version.
 */
function buildAxeRuleToScMap() {
  const audit = axe._audit;
  const map = new Map();
  for (const rule of audit.rules) {
    const scs = new Set();
    for (const tag of rule.tags) {
      const sc = scTagFromAxe(tag);
      if (sc) scs.add(sc);
    }
    map.set(rule.id, scs);
  }
  return map;
}

/**
 * Invert the map: WCAG SC -> set of axe rule ids mapped to it.
 */
function buildScToAxeRulesMap(ruleToSc) {
  const map = new Map();
  for (const [ruleId, scs] of ruleToSc) {
    for (const sc of scs) {
      if (!map.has(sc)) map.set(sc, new Set());
      map.get(sc).add(ruleId);
    }
  }
  return map;
}

/**
 * Classify a single SC based on aggregated violations.
 */
function classifySc({ applicableRules, aggregated }) {
  // No axe rules map to this SC -> not automatable
  if (applicableRules.size === 0) {
    return {
      classification: 'not-evaluated',
      reason: 'manual-check-required',
      automatable: false,
      violatedRules: [],
      urlsAffected: [],
    };
  }

  const violatedRules = aggregated.violations.filter((v) =>
    applicableRules.has(v.id),
  );

  if (violatedRules.length === 0) {
    return {
      classification: 'supports',
      reason: 'no-violations',
      automatable: true,
      violatedRules: [],
      urlsAffected: [],
    };
  }

  // Collect URLs that had violations on any mapped rule
  const urlsWithViolations = new Set();
  const allAuditedUrls = new Set();
  for (const v of violatedRules) {
    for (const u of v.urls) {
      urlsWithViolations.add(u.url);
      allAuditedUrls.add(u.url);
    }
  }

  const urlCount = aggregated.urlCount ?? urlsWithViolations.size;

  if (urlsWithViolations.size >= urlCount) {
    return {
      classification: 'does-not-support',
      reason: 'violations-on-all-urls',
      automatable: true,
      violatedRules: violatedRules.map((v) => ({
        id: v.id,
        impact: v.impact,
        urls: v.urls.length,
        nodes: v.totalNodes,
      })),
      urlsAffected: [...urlsWithViolations],
    };
  }

  return {
    classification: 'partially-supports',
    reason: 'violations-on-some-urls',
    automatable: true,
    violatedRules: violatedRules.map((v) => ({
      id: v.id,
      impact: v.impact,
      urls: v.urls.length,
      nodes: v.totalNodes,
    })),
    urlsAffected: [...urlsWithViolations],
  };
}

async function main() {
  const opts = parseCliArgs(process.argv.slice(2));

  let aggregated;
  try {
    const raw = await readFile(opts.aggregatedPath, 'utf8');
    aggregated = normalizeToAggregated(JSON.parse(raw), fail);
  } catch (err) {
    fail(`failed to read --aggregated ${opts.aggregatedPath}: ${err.message}`);
  }

  const ruleToSc = buildAxeRuleToScMap();
  const scToRules = buildScToAxeRulesMap(ruleToSc);

  const scsToScore = filterByLevel(WCAG_SCS, aggregated.level ?? 'AA');
  const scored = scsToScore.map((scEntry) => {
    const applicableRules = scToRules.get(scEntry.sc) ?? new Set();
    const result = classifySc({ applicableRules, aggregated });
    return {
      sc: scEntry.sc,
      level: scEntry.level,
      title: scEntry.title,
      newIn22: scEntry.newIn22,
      ...result,
    };
  });

  // Summary counts
  const summary = scored.reduce(
    (acc, s) => {
      acc[s.classification] = (acc[s.classification] ?? 0) + 1;
      return acc;
    },
    {},
  );

  const output = {
    generatedAt: new Date().toISOString(),
    auditStartedAt: aggregated.startedAt,
    auditFinishedAt: aggregated.finishedAt,
    level: aggregated.level,
    includeBestPractice: aggregated.includeBestPractice,
    urlCount: aggregated.urlCount,
    viewports: aggregated.viewports,
    axeVersion: axe.version,
    summary,
    scored,
  };

  const json = JSON.stringify(output, null, 2) + '\n';
  if (opts.outPath) {
    await writeFile(opts.outPath, json, 'utf8');
    process.stderr.write(
      `score: ${scored.length} SCs scored - ${opts.outPath}\n`,
    );
    process.stderr.write(`  supports:           ${summary.supports ?? 0}\n`);
    process.stderr.write(`  partially-supports: ${summary['partially-supports'] ?? 0}\n`);
    process.stderr.write(`  does-not-support:   ${summary['does-not-support'] ?? 0}\n`);
    process.stderr.write(`  not-evaluated:      ${summary['not-evaluated'] ?? 0}\n`);
  } else {
    process.stdout.write(json);
  }
  process.exit(EXIT_OK);
}

main();
