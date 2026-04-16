/**
 * version-check.mjs - warn when a newer plugin version is available
 *
 * On script startup, fetches the plugin.json from GitHub main and compares
 * against the installed VERSION. If the installed version is behind, prints
 * a one-shot stderr notice with the exact /plugin commands to upgrade.
 *
 * Fail-closed: any network error, timeout, rate-limit, or parse failure is
 * silent — the audit continues normally. Users on air-gapped networks or
 * rate-limited IPs never see a spurious warning.
 *
 * Opt-out: set WCAG_AUDITOR_SKIP_VERSION_CHECK=1 in the environment.
 */

import { VERSION } from './version.mjs';

const LATEST_URL =
  'https://raw.githubusercontent.com/benry-products/wcag-auditor/main/.claude-plugin/plugin.json';
const TIMEOUT_MS = 2000;

export async function checkForUpdates() {
  if (process.env.WCAG_AUDITOR_SKIP_VERSION_CHECK === '1') return;
  if (VERSION === 'unknown') return;

  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    const res = await fetch(LATEST_URL, { signal: ctl.signal });
    clearTimeout(timer);
    if (!res.ok) return;

    const latest = JSON.parse(await res.text()).version;
    if (typeof latest !== 'string') return;

    if (compareVersions(VERSION, latest) < 0) {
      process.stderr.write(
        `\nwcag-auditor: running v${VERSION}; latest is v${latest}.\n` +
          `  To upgrade, run in Claude Code:\n` +
          `    /plugin marketplace update wcag-auditor-tools\n` +
          `    /plugin install wcag-auditor@wcag-auditor-tools\n` +
          `  Silence this check with WCAG_AUDITOR_SKIP_VERSION_CHECK=1.\n\n`,
      );
    }
  } catch {
    // Offline, timeout, rate-limited, or malformed response — stay quiet.
  }
}

function compareVersions(a, b) {
  const pa = a.split('.').map((n) => Number(n) || 0);
  const pb = b.split('.').map((n) => Number(n) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}
