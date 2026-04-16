/**
 * normalize.mjs - shared input-shape normalizer
 *
 * audit.mjs and audit-site.mjs emit different JSON shapes:
 *
 *   - audit.mjs (single URL):
 *       { url, violations: [{ ..., nodes: [...] }], incomplete: [...],
 *         viewports: [{label,width,height,...}], ... }
 *
 *   - audit-site.mjs (aggregated):
 *       { urlCount, violations: [{ ..., urls: [{url,nodeCount,nodes}],
 *         totalNodes }], totalIncomplete, viewports: ['1280x800', ...], ... }
 *
 * Downstream scripts (score, report-generate, vpat-fill) were written against
 * the aggregated shape. This helper wraps single-URL input into aggregated
 * shape so a single code path handles both.
 */

/**
 * Normalize audit input to aggregated shape. Idempotent on aggregated input.
 * Throws via the caller's `fail` function if input matches neither shape.
 */
export function normalizeToAggregated(data, fail) {
  if (typeof data.urlCount === 'number') return data;

  if (typeof data.url !== 'string') {
    fail(
      'input is neither aggregated (audit-site.mjs) nor single-URL (audit.mjs) format: missing both "urlCount" and "url"',
    );
  }

  const violations = (data.violations ?? []).map((v) => {
    const nodeCount = v.nodes?.length ?? 0;
    return {
      ...v,
      urls: [{ url: data.url, nodeCount, nodes: v.nodes ?? [] }],
      totalNodes: nodeCount,
    };
  });

  return {
    startedAt: data.startedAt,
    finishedAt: data.finishedAt,
    level: data.level,
    includeBestPractice: data.includeBestPractice,
    axeTags: data.axeTags,
    viewports: (data.viewports ?? []).map((v) =>
      typeof v === 'string' ? v : v.label,
    ),
    urlCount: 1,
    errorCount: 0,
    totalIncomplete: data.incomplete?.length ?? 0,
    violations,
  };
}
