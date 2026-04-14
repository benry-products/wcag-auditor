---
name: wcag-auditor
description: Use when the user wants to audit their own web application for WCAG accessibility compliance, run an a11y check on a URL (including authenticated routes), generate a markdown accessibility findings report, fill in a VPAT / ACR, or get concrete remediation diffs for accessibility violations. Default target is WCAG 2.2 Level AA (covers 2.0/2.1 A/AA transitively); AAA is opt-in. VPAT fill-in requires a user-supplied ITI VPAT 2.5 INT template; covers WCAG + Section 508 + EN 301 549 via crosswalks.
version: "0.1.0"
author: Scott Baldwin
license: MIT
---

# WCAG Auditor

Audit the user's **own web application** for WCAG 2.2 accessibility compliance.
Runs axe-core via Playwright against public and authenticated routes, maps
violations to specific WCAG success criteria, and proposes concrete Edit-tool
diffs against the user's source code.

## Prerequisites

- **Node.js ≥ 22** (current active LTS). The scripts use modern ESM features and will fail on Node 20.
- **Install runtime dependencies** before first use. From the installed skill directory (typically `~/.claude/skills/wcag-auditor/`):
  ```bash
  npm install
  npx playwright install chromium
  ```
  This pulls in `playwright`, `@axe-core/playwright`, `axe-core`, `fast-xml-parser`, `docx`, and `jszip`, and downloads the Chromium binary Playwright drives.

## When to use this skill

Invoke when the user says any of:

- "audit my site for accessibility"
- "check WCAG compliance" / "run an a11y check"
- "find accessibility bugs in <URL>"
- "generate a VPAT" / "fill in an ACR" / "make an accessibility conformance report"
- "what accessibility issues does <URL> have?"
- "make my site WCAG-compliant"

Do **not** use this skill for:

- Heuristic UI/UX review unrelated to WCAG — use `web-design-guidelines` instead
- Accessibility of native mobile apps, desktop apps, or PDFs — this skill audits web content only
- Auditing sites the user does not own, where no source is available — the skill relies on reading the user's repo to propose fixes

## Workflow

### 1. Clarify scope

Ask the user (one at a time):

- **Target:** URL(s), or dev server / staging origin
- **WCAG level:** AA (default) or AAA (opt-in). AAA is aspirational — flag if the user is unsure.
- **Auth:** are some routes behind a login?
- **Viewports:** defaults are 1280×800 (desktop) + 375×667 (mobile). Override if needed.
- **Framework:** ask only if not obvious from the repo (needed for URL discovery)

### 2. Discover URLs

Consult `references/url-discovery.md`. Detect the framework from the user's
repo (package.json, file layout), run the appropriate recipe to extract a
route list, resolve any dynamic segments (`[id]`, `:id`) to concrete URLs
using real test-user IDs, and produce `urls.txt`. Show the list for review
before auditing.

For authenticated SaaS routes, sitemaps are insufficient — the framework
recipe is essential.

### 3. Set up auth (if needed)

```bash
node scripts/login.mjs --url <login-url> --out ./auth.json
```

Playwright opens a headed browser; the user completes login (including MFA)
and presses Enter in the terminal. Session state saves to `./auth.json`.

**Important caveats to communicate:**
- `auth.json` contains live session credentials — already gitignored, never commit it
- Session expires when the user's app session expires; re-run `login.mjs` when needed
- CSRF tokens with short lifetimes may require re-login

### 4. Run the automated audit

Single URL:
```bash
node scripts/audit.mjs --url <url> --auth ./auth.json --out ./audit.json
```

Multi-URL (recommended):
```bash
node scripts/audit-site.mjs \
  --urls ./urls.txt \
  [--sitemap https://example.com/sitemap.xml] \
  [--crawl-from https://example.com/dashboard --depth 2] \
  --auth ./auth.json \
  --out ./audit/
```

Outputs `./audit/aggregated.json` plus per-URL JSON files and `urls.resolved.txt`.

### 5. Run the manual-check pass

Automated axe catches ~30–40% of WCAG failures. For each audited URL, walk
through `references/manual-checks.md` and run the documented Playwright MCP
procedures. Key manual checks:

- **SC 2.4.7 Focus Visible** — Tab through the page, verify focus indicator visible at each step
- **SC 2.1.2 No Keyboard Trap** — verify every widget can be escaped via keyboard
- **SC 1.4.10 Reflow** — resize to 320×800, confirm no horizontal scrolling
- **SC 2.5.8 Target Size (Minimum)** — verify interactive targets ≥ 24×24 CSS pixels
- **SC 1.3.4 Orientation** — resize to portrait and landscape phone dimensions
- **SC 3.2.6 Consistent Help** (new in 2.2) — help mechanism in same relative position across pages

Use `mcp__plugin_playwright_playwright__browser_*` tools. Record each manual
finding the same way as axe violations: cite the SC, describe the failure,
propose a fix.

For AAA audits, also consult `references/manual-checks-aaa.md`.

### 6. Score and derive conformance

```bash
node scripts/score.mjs --aggregated ./audit/aggregated.json --out ./audit/score.json
```

Produces per-SC classification (Supports / Partially Supports / Does Not
Support / Not Evaluated). The `not-evaluated` SCs are those that require
manual-check results — update them based on step 5.

### 7. Triage & remediate (conversational)

For each violation (automated or manual):

1. Cite the WCAG SC by number and title (look up in `references/wcag-2.2-criteria.md`)
2. Explain user impact plainly (who is affected, how)
3. **Locate the source**: match axe's CSS selector and HTML snippet to files in the user's repo. Use `Grep` for HTML patterns, `Glob` for component files.
4. Pick the closest remediation pattern from `references/remediation-patterns.md`
5. Propose a concrete `Edit` tool diff against the matched source file
6. For complex cases, explain the fix first, then offer the edit

This is the high-value step — the report is useful, but engineering teams
want diffs.

### 8. Generate the findings report

```bash
node scripts/report-generate.mjs \
  --aggregated ./audit/aggregated.json \
  --score ./audit/score.json \
  --out ./report.md
```

Deterministic markdown — same inputs produce byte-identical output. Safe to
diff between runs, commit to the repo, or publish.

### 9. (Optional) Generate the VPAT ACR

If the user needs a formal Accessibility Conformance Report:

```bash
# Worksheet mode — always works, no template needed
node scripts/vpat-fill.mjs \
  --aggregated ./audit/aggregated.json \
  --score ./audit/score.json \
  --product "MyApp" --version "1.0"

# .docx mode — user downloads ITI template first
node scripts/vpat-fill.mjs \
  --aggregated ./audit/aggregated.json \
  --score ./audit/score.json \
  --product "MyApp" --version "1.0" \
  --template ./VPAT2.5INT.docx \
  --out ./ACR-MyApp.docx
```

The skill **does not redistribute the ITI template.** Direct the user to
download it from [itic.org/policy/accessibility/vpat](https://www.itic.org/policy/accessibility/vpat)
for `.docx` mode. The worksheet markdown mode works standalone.

### 10. Re-audit after fixes

Rerun step 4. Diff the new `aggregated.json` against the prior one to confirm
violations were fixed and none regressed.

## Flag reference

### `audit.mjs` / `audit-site.mjs`

| Flag | Purpose |
|---|---|
| `--url <url>` / `--urls <path>` / `--sitemap <url>` / `--crawl-from <url>` | URL sources (at least one required for audit-site) |
| `--depth <n>` | Crawl depth for `--crawl-from` (default 1) |
| `--include <glob>` / `--exclude <glob>` | URL filters (repeatable) |
| `--auth <path>` | Playwright `storageState` JSON |
| `--level AA\|AAA` | WCAG level (default AA) |
| `--viewport <WxH>` | Viewport (repeatable; default: 1280x800 + 375x667) |
| `--concurrency <n>` | Parallel audits (default 1, safe for dev servers) |
| `--include-best-practice` | Include axe best-practice rules (non-normative) |
| `--out <path>` | Output path/directory |
| `--fail-on <level>` | Exit 1 on violations ≥ level; one of: none\|minor\|moderate\|serious\|critical\|any (default: none) |

### Exit codes (all scripts)

- `0` — success, threshold not crossed
- `1` — success, threshold crossed (a11y gate failed)
- `2` — script error (network, bad URL, expired auth, axe crash)

## Reference files

| File | Purpose |
|---|---|
| `references/wcag-2.2-criteria.md` | All 86 SCs: number, level, title, intent, W3C URL |
| `references/axe-rule-mapping.md` | axe rule → WCAG SC mapping (auto-generated from axe-core) |
| `references/manual-checks.md` | Manual-check procedures for A/AA SCs axe can't automate |
| `references/manual-checks-aaa.md` | AAA-only manual checks |
| `references/remediation-patterns.md` | Fix library: per rule, HTML/JSX/ARIA snippets |
| `references/url-discovery.md` | Per-framework recipes to generate `urls.txt` |
| `references/section-508-mapping.md` | 508 ↔ WCAG crosswalk |
| `references/en-301-549-mapping.md` | EN 301 549 ↔ WCAG crosswalk |
| `references/vpat-mapping.md` | How findings map into VPAT tables |

## Known limitations (v0.1.0)

- **Auth:** `storageState` only. No bearer tokens, basic auth, or custom headers.
- **Multi-framework:** each audit run covers one framework's recipe at a time.
- **508/EN 301 549:** cells derived from WCAG findings via crosswalks, not independently evaluated.
- **VPAT `.docx` fill-in:** best-effort — template layouts vary. The worksheet is always produced as a safety net.
- **Framework route-manifest parsers:** deferred to v0.2.0. Use documented recipes in `url-discovery.md` for now.
- **Baseline / suppressions file:** not yet supported. Deferred to v0.2.0.
