#!/usr/bin/env node
/**
 * report-generate.mjs - deterministic aggregated.json -> report.md
 *
 * Produces a human-readable markdown findings report. Same input always
 * produces byte-identical output. Conversational triage (Claude proposing
 * Edit diffs) is a separate, parallel flow; this file is the shareable
 * artifact.
 *
 * Usage:
 *   node report-generate.mjs --aggregated <path> [--score <path>] [--out <path>]
 *
 * If --score is omitted, the report shows axe findings only (no per-SC
 * conformance table). Passing a score.json produces the full report.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { normalizeToAggregated } from './lib/normalize.mjs';

const EXIT_OK = 0;
const EXIT_SCRIPT_ERROR = 2;

const IMPACT_ORDER = { critical: 0, serious: 1, moderate: 2, minor: 3 };

function parseCliArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      aggregated: { type: 'string' },
      score: { type: 'string' },
      out: { type: 'string', default: './wcag-audit/report.md' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false,
    strict: true,
  });

  if (values.help) {
    printHelp();
    process.exit(EXIT_OK);
  }

  if (!values.aggregated) fail('--aggregated is required');

  return {
    aggregatedPath: resolve(values.aggregated),
    scorePath: values.score ? resolve(values.score) : null,
    outPath: resolve(values.out),
  };
}

function printHelp() {
  process.stdout.write(`report-generate.mjs - render aggregated.json to report.md

Usage:
  node report-generate.mjs --aggregated <path> [--score <path>] [--out ./report.md]

Options:
  --aggregated <path>  aggregated.json from audit-site.mjs,
                       OR a single-URL audit JSON from audit.mjs
                       (single-URL input is wrapped internally)
  --score <path>       score.json from score.mjs (enables per-SC table)
  --out <path>         output markdown path (default: ./wcag-audit/report.md)
  -h, --help           show this help

Output is deterministic: same inputs produce byte-identical output.
`);
}

function fail(msg) {
  process.stderr.write(`report-generate.mjs: ${msg}\n`);
  process.exit(EXIT_SCRIPT_ERROR);
}

function sortViolations(violations) {
  return [...violations].sort((a, b) => {
    const ai = IMPACT_ORDER[a.impact] ?? 99;
    const bi = IMPACT_ORDER[b.impact] ?? 99;
    if (ai !== bi) return ai - bi;
    return a.id.localeCompare(b.id);
  });
}

function sortUrlOccurrences(urls) {
  return [...urls].sort((a, b) => a.url.localeCompare(b.url));
}

function sortNodes(nodes) {
  return [...nodes].sort((a, b) => {
    const ak = JSON.stringify(a.target);
    const bk = JSON.stringify(b.target);
    return ak.localeCompare(bk);
  });
}

function renderHeader(aggregated) {
  const lines = [];
  lines.push('# Accessibility Findings Report');
  lines.push('');
  lines.push(`**Audit completed:** ${aggregated.finishedAt ?? '—'}`);
  lines.push(`**WCAG target:** Level ${aggregated.level}`);
  lines.push(`**URLs audited:** ${aggregated.urlCount}`);
  lines.push(`**Viewports:** ${(aggregated.viewports ?? []).join(', ')}`);
  lines.push(
    `**Best-practice rules:** ${aggregated.includeBestPractice ? 'included' : 'excluded (WCAG-normative only)'}`,
  );
  if (aggregated.errorCount && aggregated.errorCount > 0) {
    lines.push(`**URLs with errors:** ${aggregated.errorCount}`);
  }
  lines.push('');
  return lines.join('\n');
}

function renderSummary(aggregated, score) {
  const lines = [];
  lines.push('## Summary');
  lines.push('');

  const totalInstances = aggregated.violations.reduce(
    (s, v) => s + (v.totalNodes ?? 0),
    0,
  );

  lines.push('| Metric | Count |');
  lines.push('|---|---|');
  lines.push(`| Unique axe rules violated | ${aggregated.violations.length} |`);
  lines.push(`| Total violation instances | ${totalInstances} |`);
  lines.push(`| Incomplete (needs manual review) | ${aggregated.totalIncomplete ?? 0} |`);
  if (score) {
    const s = score.summary;
    lines.push(`| SCs classified: Supports | ${s.supports ?? 0} |`);
    lines.push(`| SCs classified: Partially Supports | ${s['partially-supports'] ?? 0} |`);
    lines.push(`| SCs classified: Does Not Support | ${s['does-not-support'] ?? 0} |`);
    lines.push(`| SCs classified: Not Evaluated (manual check required) | ${s['not-evaluated'] ?? 0} |`);
  }
  lines.push('');

  // Violations grouped by impact
  const byImpact = {};
  for (const v of aggregated.violations) {
    byImpact[v.impact] = (byImpact[v.impact] ?? 0) + 1;
  }
  if (Object.keys(byImpact).length > 0) {
    lines.push('### Violations by impact');
    lines.push('');
    lines.push('| Impact | Rules | Instances |');
    lines.push('|---|---|---|');
    for (const impact of ['critical', 'serious', 'moderate', 'minor']) {
      if (!byImpact[impact]) continue;
      const rulesAtImpact = aggregated.violations.filter(
        (v) => v.impact === impact,
      );
      const instances = rulesAtImpact.reduce(
        (s, v) => s + (v.totalNodes ?? 0),
        0,
      );
      lines.push(`| ${impact} | ${rulesAtImpact.length} | ${instances} |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function renderConformanceTable(score) {
  const lines = [];
  lines.push('## WCAG Conformance');
  lines.push('');
  lines.push(
    'Per-SC classification derived from automated findings. SCs that cannot ' +
      'be automated are marked *Not Evaluated* — they require manual ' +
      'verification (see `manual-checks.md`).',
  );
  lines.push('');
  lines.push('| SC | Level | Title | Classification |');
  lines.push('|---|---|---|---|');
  for (const s of score.scored) {
    const label = classificationLabel(s.classification);
    const starred = s.newIn22 ? ' ★' : '';
    lines.push(`| ${s.sc}${starred} | ${s.level} | ${s.title} | ${label} |`);
  }
  lines.push('');
  lines.push('★ = new in WCAG 2.2');
  lines.push('');
  return lines.join('\n');
}

function classificationLabel(c) {
  switch (c) {
    case 'supports': return 'Supports';
    case 'partially-supports': return 'Partially Supports';
    case 'does-not-support': return 'Does Not Support';
    case 'not-applicable': return 'Not Applicable';
    case 'not-evaluated': return 'Not Evaluated (manual)';
    default: return c;
  }
}

function renderViolations(aggregated) {
  const lines = [];
  lines.push('## Violations');
  lines.push('');

  if (aggregated.violations.length === 0) {
    lines.push('_No violations found._');
    lines.push('');
    return lines.join('\n');
  }

  for (const v of sortViolations(aggregated.violations)) {
    lines.push(`### \`${v.id}\` — ${v.help} _(impact: ${v.impact})_`);
    lines.push('');
    lines.push(v.description);
    lines.push('');
    lines.push(`**Rule documentation:** <${v.helpUrl}>`);
    lines.push('');
    const wcagTags = (v.tags ?? []).filter((t) => /^wcag\d/.test(t)).join(', ');
    if (wcagTags) {
      lines.push(`**WCAG tags:** ${wcagTags}`);
      lines.push('');
    }
    lines.push(
      `**Affected:** ${v.urls.length} URL(s), ${v.totalNodes} node(s)`,
    );
    lines.push('');

    for (const urlEntry of sortUrlOccurrences(v.urls)) {
      lines.push(`#### ${urlEntry.url}`);
      lines.push('');
      lines.push(`${urlEntry.nodeCount} node(s):`);
      lines.push('');
      for (const node of sortNodes(urlEntry.nodes)) {
        const selector = Array.isArray(node.target)
          ? node.target.join(' ')
          : String(node.target);
        lines.push(`- **Selector:** \`${selector}\``);
        const viewports = (node.viewports ?? []).join(', ');
        if (viewports) lines.push(`  **Viewports:** ${viewports}`);
        lines.push('  ```html');
        lines.push(`  ${truncate(node.html, 300)}`);
        lines.push('  ```');
        if (node.failureSummary) {
          lines.push(`  ${node.failureSummary.replace(/\n/g, ' ')}`);
        }
      }
      lines.push('');
    }
  }
  return lines.join('\n');
}

function truncate(s, n) {
  if (!s) return '';
  const cleaned = s.replace(/\s+/g, ' ').trim();
  return cleaned.length > n ? cleaned.slice(0, n) + '…' : cleaned;
}

function renderFooter(aggregated) {
  const lines = [];
  lines.push('---');
  lines.push('');
  lines.push(
    `_Generated by wcag-auditor. axe tags: ${(aggregated.axeTags ?? []).join(', ')}._`,
  );
  lines.push('');
  return lines.join('\n');
}

async function main() {
  const opts = parseCliArgs(process.argv.slice(2));

  let aggregated;
  try {
    aggregated = normalizeToAggregated(
      JSON.parse(await readFile(opts.aggregatedPath, 'utf8')),
      fail,
    );
  } catch (err) {
    fail(`failed to read --aggregated: ${err.message}`);
  }

  let score = null;
  if (opts.scorePath) {
    try {
      score = JSON.parse(await readFile(opts.scorePath, 'utf8'));
    } catch (err) {
      fail(`failed to read --score: ${err.message}`);
    }
  }

  const md = [
    renderHeader(aggregated),
    renderSummary(aggregated, score),
    score ? renderConformanceTable(score) : '',
    renderViolations(aggregated),
    renderFooter(aggregated),
  ]
    .filter(Boolean)
    .join('\n');

  await mkdir(dirname(opts.outPath), { recursive: true });
  await writeFile(opts.outPath, md, 'utf8');
  process.stderr.write(`report-generate: ${opts.outPath}\n`);
  process.exit(EXIT_OK);
}

main();
