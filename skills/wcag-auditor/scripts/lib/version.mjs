/**
 * version.mjs - read plugin version from package.json at the plugin root.
 *
 * Used by every script to log `<script-name> v<VERSION>` to stderr on
 * startup, so users can see which version actually ran even if their
 * plugin cache is stale.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

let cached;
function readVersion() {
  if (cached) return cached;
  try {
    // scripts/lib/version.mjs -> plugin root is four levels up
    const pkgPath = resolve(__dirname, '..', '..', '..', '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    cached = pkg.version ?? 'unknown';
  } catch {
    cached = 'unknown';
  }
  return cached;
}

export const VERSION = readVersion();

export function printVersionBanner(scriptName) {
  process.stderr.write(`${scriptName} v${VERSION}\n`);
}
