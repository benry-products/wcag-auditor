#!/usr/bin/env node
/**
 * vpat-fill.mjs - populate a VPAT 2.5 INT Accessibility Conformance Report
 *
 * Two modes:
 *
 *   1. Worksheet mode (default, always produced):
 *      Generates a markdown "VPAT fill worksheet" containing every SC / clause
 *      to be populated, with the skill's classification and remarks. The user
 *      transcribes these into the ITI template manually.
 *
 *   2. .docx mode (when --template <path> given):
 *      Best-effort: reads the user-supplied ITI VPAT 2.5 INT .docx, locates
 *      table rows by SC number, and populates Conformance Level + Remarks
 *      cells. Emits a new .docx at --out. The worksheet is still produced as
 *      a safety-net companion artifact.
 *
 * The skill does NOT redistribute the ITI template. The .docx mode requires
 * the user to download their own copy from itic.org/policy/accessibility/vpat.
 */

import JSZip from 'jszip';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname, basename, join } from 'node:path';
import { parseArgs } from 'node:util';
import { normalizeToAggregated } from './lib/normalize.mjs';
import { printVersionBanner } from './lib/version.mjs';

const EXIT_OK = 0;
const EXIT_SCRIPT_ERROR = 2;

function parseCliArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      aggregated: { type: 'string' },
      score: { type: 'string' },
      product: { type: 'string' },
      version: { type: 'string' },
      template: { type: 'string' },
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

  if (!values.aggregated) fail('--aggregated is required');
  if (!values.score) fail('--score is required');
  if (!values.product) fail('--product is required');
  if (!values.version) fail('--version is required');

  const datestamp = new Date().toISOString().slice(0, 10);
  const baseName = `ACR-${sanitize(values.product)}-${datestamp}`;
  const defaultOut = values.template
    ? `./wcag-audit/${baseName}.docx`
    : `./wcag-audit/${baseName}-worksheet.md`;

  return {
    aggregatedPath: resolve(values.aggregated),
    scorePath: resolve(values.score),
    product: values.product,
    version: values.version,
    templatePath: values.template ? resolve(values.template) : null,
    outPath: resolve(values.out ?? defaultOut),
    baseName,
  };
}

function sanitize(s) {
  return s.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

function printHelp() {
  process.stdout.write(`vpat-fill.mjs - populate VPAT 2.5 INT ACR

Usage:
  node vpat-fill.mjs --aggregated <path> --score <path> \\
    --product "<name>" --version "<v>" \\
    [--template <path-to-iti-docx>] [--out <path>]

Required:
  --aggregated <path>    aggregated.json from audit-site.mjs,
                         OR a single-URL audit JSON from audit.mjs
                         (single-URL input is wrapped internally)
  --score <path>         score.json from score.mjs
  --product "<name>"     product name for the ACR
  --version "<v>"        product version for the ACR

Optional:
  --template <path>      user-supplied ITI VPAT 2.5 INT .docx
                         if provided, emits filled .docx AND worksheet
                         if omitted, emits worksheet only
  --out <path>           output path; default:
                           ./wcag-audit/ACR-<product>-<date>.docx (with --template)
                           ./wcag-audit/ACR-<product>-<date>-worksheet.md (without)
  -h, --help             show this help

The skill does NOT redistribute the ITI template. Download your own from
https://www.itic.org/policy/accessibility/vpat before using --template.
`);
}

function fail(msg) {
  process.stderr.write(`vpat-fill.mjs: ${msg}\n`);
  process.exit(EXIT_SCRIPT_ERROR);
}

function conformanceLabel(c) {
  switch (c) {
    case 'supports': return 'Supports';
    case 'partially-supports': return 'Partially Supports';
    case 'does-not-support': return 'Does Not Support';
    case 'not-applicable': return 'Not Applicable';
    case 'not-evaluated': return 'Not Evaluated';
    default: return c;
  }
}

function buildRows({ score, aggregated }) {
  return score.scored.map((s) => ({
    sc: s.sc,
    level: s.level,
    title: s.title,
    newIn22: s.newIn22,
    classification: s.classification,
    conformanceLabel: conformanceLabel(s.classification),
    remarks: buildRemarks(s, aggregated),
  }));
}

function buildRemarks(scoredEntry, aggregated) {
  const parts = [];
  if (!scoredEntry.automatable) {
    parts.push('Requires manual verification; not covered by automated testing.');
  }
  if (scoredEntry.violatedRules.length > 0) {
    const total = aggregated.urlCount ?? scoredEntry.urlsAffected.length;
    for (const rule of scoredEntry.violatedRules) {
      parts.push(
        `[axe ${rule.id}] ${rule.nodes} violation node(s) on ${rule.urls}/${total} URL(s) (impact: ${rule.impact}).`,
      );
    }
  } else if (scoredEntry.automatable) {
    parts.push('No automated violations detected.');
  }
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// Worksheet rendering
// ---------------------------------------------------------------------------

function renderWorksheet({ rows, product, version, aggregated, score }) {
  const date = new Date().toISOString().slice(0, 10);
  const lines = [];
  lines.push(`# VPAT 2.5 INT Fill Worksheet — ${product} ${version}`);
  lines.push('');
  lines.push(
    'Transcribe the values below into your downloaded ITI VPAT 2.5 INT ' +
      'template. The skill does not redistribute ITI\'s template; download ' +
      'the current version from <https://www.itic.org/policy/accessibility/vpat>.',
  );
  lines.push('');
  lines.push('## Product Information');
  lines.push('');
  lines.push(`- **Name of Product:** ${product}`);
  lines.push(`- **Version:** ${version}`);
  lines.push(`- **Report Date:** ${date}`);
  lines.push(
    `- **Evaluation Methods Used:** Automated testing using axe-core ${score.axeVersion ?? '(see score.json)'} via Playwright at viewports ${(aggregated.viewports ?? []).join(', ')}, against ${aggregated.urlCount} URL(s). Manual verification performed for success criteria that cannot be automated. Authentication state captured via Playwright storageState for authenticated routes.`,
  );
  lines.push('');
  lines.push('## Applicable Standards/Guidelines');
  lines.push('');
  lines.push(`- Web Content Accessibility Guidelines 2.2 (Level ${aggregated.level})`);
  lines.push('- Revised Section 508 Standards, 36 CFR Part 1194');
  lines.push('- EN 301 549 V3.2.1 (2021-03)');
  lines.push('');
  lines.push('## WCAG 2.x Report — per-SC Conformance');
  lines.push('');
  lines.push('| SC | Level | Title | Conformance Level | Remarks and Explanations |');
  lines.push('|---|---|---|---|---|');
  for (const r of rows) {
    const starred = r.newIn22 ? ' ★' : '';
    const remarks = (r.remarks || '—').replace(/\|/g, '\\|');
    lines.push(`| ${r.sc}${starred} | ${r.level} | ${r.title} | ${r.conformanceLabel} | ${remarks} |`);
  }
  lines.push('');
  lines.push('## Section 508 Report — derivation notes');
  lines.push('');
  lines.push(
    'Per `references/section-508-mapping.md`: the Section 508 §501.1 cells ' +
      'inherit directly from the WCAG 2.0 Level A/AA rows above. Chapters 4 ' +
      '(Hardware) and 6 (Support Documentation) are marked Not Applicable: ' +
      'audited product is web content. WCAG 2.1/2.2 additions are marked ' +
      '"Not Applicable: criterion not required by Revised Section 508."',
  );
  lines.push('');
  lines.push('## EN 301 549 Report — derivation notes');
  lines.push('');
  lines.push(
    'Per `references/en-301-549-mapping.md`: the EN 301 549 Clause 9 cells ' +
      'inherit from the WCAG 2.1 Level A/AA rows above. Clauses 5–8, 10, 11, ' +
      '12, and 13 are marked Not Applicable: audited product is web content. ' +
      'WCAG 2.2 additions are marked "Not Applicable: criterion not required ' +
      'by EN 301 549 v3.2.1."',
  );
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('_Generated by wcag-auditor vpat-fill.mjs._');
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// .docx fill-in (best-effort)
// ---------------------------------------------------------------------------

async function fillDocx({ templatePath, rows, outPath }) {
  const templateBuf = await readFile(templatePath);
  const zip = await JSZip.loadAsync(templateBuf);

  const docXmlEntry = zip.file('word/document.xml');
  if (!docXmlEntry) {
    throw new Error('template is not a valid .docx (missing word/document.xml)');
  }
  let xml = await docXmlEntry.async('string');

  const scByNumber = new Map(rows.map((r) => [r.sc, r]));
  let matchedCount = 0;

  xml = xml.replace(/<w:tr\b[^>]*>[\s\S]*?<\/w:tr>/g, (rowXml) => {
    const textContent = extractVisibleText(rowXml);
    const scMatch = textContent.match(/\b([1-4]\.\d{1,2}\.\d{1,2})\b/);
    if (!scMatch) return rowXml;
    const row = scByNumber.get(scMatch[1]);
    if (!row) return rowXml;
    matchedCount++;
    return populateRow(rowXml, row);
  });

  if (matchedCount === 0) {
    throw new Error(
      'no VPAT SC rows matched in template — confirm template is a VPAT 2.5 INT .docx',
    );
  }

  zip.file('word/document.xml', xml);
  const outBuf = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
  });
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, outBuf);
  return matchedCount;
}

function extractVisibleText(xml) {
  const matches = [...xml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)];
  return matches.map((m) => m[1]).join(' ');
}

function populateRow(rowXml, row) {
  const cells = splitCells(rowXml);
  if (cells.length < 3) return rowXml;
  const conformanceIdx = cells.length - 2;
  const remarksIdx = cells.length - 1;
  cells[conformanceIdx] = writeCellText(cells[conformanceIdx], row.conformanceLabel);
  cells[remarksIdx] = writeCellText(cells[remarksIdx], row.remarks || '—');
  return joinCells(rowXml, cells);
}

function splitCells(rowXml) {
  return [...rowXml.matchAll(/<w:tc\b[^>]*>[\s\S]*?<\/w:tc>/g)].map((m) => m[0]);
}

function joinCells(rowXml, newCells) {
  let i = 0;
  return rowXml.replace(/<w:tc\b[^>]*>[\s\S]*?<\/w:tc>/g, () => newCells[i++] ?? '');
}

function writeCellText(cellXml, text) {
  const escaped = escapeXml(text);
  if (/<w:t[^>]*>[^<]*<\/w:t>/.test(cellXml)) {
    return cellXml.replace(
      /<w:t[^>]*>[^<]*<\/w:t>/,
      (match) => match.replace(/>[^<]*</, `>${escaped}<`),
    );
  }
  if (/<w:p\b/.test(cellXml)) {
    return cellXml.replace(
      /<w:p\b([^>]*)>/,
      `<w:p$1><w:r><w:t xml:space="preserve">${escaped}</w:t></w:r>`,
    );
  }
  return cellXml;
}

function escapeXml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

async function main() {
  printVersionBanner('vpat-fill.mjs');
  const opts = parseCliArgs(process.argv.slice(2));

  let aggregated, score;
  try {
    aggregated = normalizeToAggregated(
      JSON.parse(await readFile(opts.aggregatedPath, 'utf8')),
      fail,
    );
    score = JSON.parse(await readFile(opts.scorePath, 'utf8'));
  } catch (err) {
    fail(`failed to read inputs: ${err.message}`);
  }

  const rows = buildRows({ score, aggregated });

  const worksheetPath = opts.templatePath
    ? join(dirname(opts.outPath), `${basename(opts.outPath, '.docx')}-worksheet.md`)
    : opts.outPath;
  const worksheetMd = renderWorksheet({
    rows,
    product: opts.product,
    version: opts.version,
    aggregated,
    score,
  });
  await mkdir(dirname(worksheetPath), { recursive: true });
  await writeFile(worksheetPath, worksheetMd, 'utf8');
  process.stderr.write(`vpat-fill: worksheet -> ${worksheetPath}\n`);

  if (opts.templatePath) {
    try {
      const matched = await fillDocx({
        templatePath: opts.templatePath,
        rows,
        outPath: opts.outPath,
      });
      process.stderr.write(
        `vpat-fill: docx populated (${matched} SC row(s) matched) -> ${opts.outPath}\n`,
      );
      process.stderr.write(
        `vpat-fill: NOTE: .docx fill-in is best-effort. Verify output against your template.\n`,
      );
    } catch (err) {
      process.stderr.write(`vpat-fill: .docx fill-in failed: ${err.message}\n`);
      process.stderr.write(`vpat-fill: worksheet contains the full data — transcribe manually.\n`);
      process.exit(EXIT_SCRIPT_ERROR);
    }
  }

  process.exit(EXIT_OK);
}

main();
