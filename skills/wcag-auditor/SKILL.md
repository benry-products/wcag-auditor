---
name: wcag-auditor
description: Use when the user wants to audit their own web application for WCAG accessibility compliance, run an a11y check on a URL (including authenticated routes), generate a markdown accessibility findings report, fill in a VPAT / ACR, or get concrete remediation diffs for accessibility violations. Default target is WCAG 2.2 Level AA (covers 2.0/2.1 A/AA transitively); AAA is opt-in. VPAT fill-in requires a user-supplied ITI VPAT 2.5 INT template; covers WCAG + Section 508 + EN 301 549 via crosswalks.
version: "0.1.7"
author: Scott Baldwin
license: MIT
tags:
  - accessibility
  - wcag
  - a11y
  - axe-core
  - playwright
  - vpat
  - testing
---

# WCAG Auditor

Audit the user's **own web application** for WCAG 2.2 accessibility compliance.
Runs axe-core via Playwright against public and authenticated routes, maps
violations to specific WCAG success criteria, and proposes concrete Edit-tool
diffs against the user's source code.

## Prerequisites

- **Node.js ≥ 22** (current active LTS). The scripts use modern ESM features and will fail on Node 20. This is the only thing the user must install themselves.
- **Runtime dependencies** (`playwright`, `@axe-core/playwright`, `axe-core`, `fast-xml-parser`, `docx`, `jszip`) and the **Playwright Chromium binary** are installed automatically by Claude on first use — see the bootstrap step at the top of the workflow. The user does not run anything manually.

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

### 0. Bootstrap (auto, on first use and after plugin updates)

**Run this before step 1 every time the skill is invoked.** It is a cheap
no-op when dependencies are already installed, and it self-heals after
plugin version bumps (which land the skill in a new versioned cache dir
without `node_modules/`).

Determine the skill install dir — typically the directory that contains
this `SKILL.md`. In a plugin install that will be something like:

```
~/.claude/plugins/cache/wcag-auditor-tools/wcag-auditor/<version>/skills/wcag-auditor/
```

The skill's `package.json` lives at the **plugin root** (two levels up
from `skills/wcag-auditor/`). From now on, use `<PLUGIN_ROOT>` to refer to
that directory. **Do not `cd` into it** — `cd` can be fragile across Claude
Code shells (especially on Windows where paths contain spaces and
backslashes). Instead, pass the plugin root as an absolute path to every
command, either via `--prefix` (for npm) or as part of the argument path.

1. If `<PLUGIN_ROOT>/node_modules/` does not exist, install dependencies.
   Use `--prefix` so the command works regardless of current working
   directory and without needing a `cd`:
   ```bash
   npm install --prefix "<PLUGIN_ROOT>"
   ```
   This installs `playwright`, `@axe-core/playwright`, `axe-core`,
   `fast-xml-parser`, `docx`, and `jszip`. Tarballs are npm-cached
   globally, so subsequent installs after plugin updates are fast.

2. Install the Playwright Chromium binary. **Always invoke Playwright's
   CLI entry point directly via `node`**, *not* via `npx playwright` and
   *never* via `node_modules/.bin/playwright` — the `.bin/` shim is a
   bash script on Unix and a `.cmd` on Windows, and trying to run it
   with `node <path-to-shim>` on Windows fails with a `SyntaxError:
   missing ) after argument list` (Node parses the bash shebang script
   as JavaScript). The CLI entry point is an ESM file and is fully
   cross-platform:
   ```bash
   node "<PLUGIN_ROOT>/node_modules/playwright/cli.js" install chromium
   ```
   Exits in under a second with "chromium X is already installed" when
   the correct revision is cached (`~/Library/Caches/ms-playwright/` on
   macOS, `~/.cache/ms-playwright/` on Linux,
   `%LOCALAPPDATA%\ms-playwright\` on Windows). Downloads only when
   Playwright version changed.

Both commands are idempotent. If the user has not pre-authorized `npm` /
`node` in their Claude Code permissions, the first invocation prompts for
approval; after that they run silently.

Do not proceed to step 1 until both commands complete successfully
(exit 0). If `npm install` fails (e.g., offline, disk full), surface
the error and stop — the audit scripts cannot run without dependencies.

**Platform note:** on Windows, `<PLUGIN_ROOT>` will look like
`C:\Users\<Name>\.claude\plugins\cache\wcag-auditor-tools\wcag-auditor\<version>`.
Always quote the path when passing to `--prefix` or as an argument, since
it almost always contains spaces (e.g., OneDrive-synced home directories).

### 1. Clarify scope (mandatory gate)

**You MUST confirm all scope parameters with the user via the `AskUserQuestion`
tool before running any audit, login, or score script.** This holds even when
the user's prompt appears complete and even when defaults seem obviously
correct — the user has explicitly opted into confirming defaults rather than
having them silently assumed.

The only exception: if the user has said in this conversation "use defaults,
don't ask" (or equivalent), skip to step 2.

Use `AskUserQuestion` to confirm each of the following. Pre-fill the option
list with the inferred or default value marked, so the user can accept with
one click:

- **Target URL(s)** — the URL, dev server, or staging origin to audit. If the
  user provided one, present it as the default option alongside "something
  else". If not, this is a free-text answer.
- **WCAG level** — options: `AA (default)`, `AAA (opt-in, aspirational)`.
- **Auth required** — options: `No, public routes only`, `Yes, capture session via login.mjs`.
- **Viewports** — options: `Desktop 1280×800 + mobile 375×667 (default)`, `Custom`.
- **Framework** — only ask if the framework is not unambiguously detectable
  from the repo (`package.json`, file layout). If detection is clear, state
  the detected framework in your next message and proceed without asking.

Do not start step 2 until every applicable question above has been answered.

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

All outputs default to `./wcag-audit/` in the current working directory —
a single workspace directory keeps audit artifacts together and easy to
`.gitignore`. Override with `--out` if needed.

Single URL:
```bash
node scripts/audit.mjs --url <url> --auth ./auth.json
# writes ./wcag-audit/audit-<timestamp>.json
```

Multi-URL (recommended):
```bash
node scripts/audit-site.mjs \
  --urls ./urls.txt \
  [--sitemap https://example.com/sitemap.xml] \
  [--crawl-from https://example.com/dashboard --depth 2] \
  --auth ./auth.json
# writes ./wcag-audit/aggregated.json + per-URL JSON + urls.resolved.txt
```

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
# Multi-URL input
node scripts/score.mjs \
  --aggregated ./wcag-audit/aggregated.json \
  --out ./wcag-audit/score.json

# Single-URL input is also accepted (wrapped to aggregated shape internally)
node scripts/score.mjs \
  --aggregated ./wcag-audit/audit-<timestamp>.json \
  --out ./wcag-audit/score.json
```

Produces per-SC classification (Supports / Partially Supports / Does Not
Support / Not Evaluated). The `not-evaluated` SCs are those that require
manual-check results — update them based on step 5.

### 7. Triage & remediate (conversational)

Before starting: announce the total violation count (e.g., "5 violations
found; I'll walk through each one.") and keep an internal list of which
violations are pending, fixed, or declined as you go.

For **each** violation (automated or manual):

1. Cite the WCAG SC by number and title (look up in `references/wcag-2.2-criteria.md`)
2. Explain user impact plainly (who is affected, how)
3. **Locate the source**: match axe's CSS selector and HTML snippet to files in the user's repo. Use `Grep` for HTML patterns, `Glob` for component files.
4. Pick the closest remediation pattern from `references/remediation-patterns.md`
5. Propose a concrete `Edit` tool diff against the matched source file
6. For complex cases, explain the fix first, then offer the edit

**Handling the user's response (critical):**

- **Accept / yes / "fix it"** → apply the edit, mark this violation fixed,
  move to the **next violation in the list** without waiting for further
  input.
- **Decline / no / "skip" / "not now"** → do **not** stop. Mark this
  violation declined, note any reason the user gave, and move to the
  **next violation in the list** immediately. A "no" on one violation is
  never a signal to end the walkthrough — it only ends this one item.
- **"Stop" / "end" / "that's enough"** → this is the only input that
  ends the walkthrough early. Everything else continues.
- **Clarifying question** → answer it, then re-ask the accept/decline
  question for the same violation.

Do not batch-ask ("want me to fix all of them?") — present one violation
at a time so the user can make per-item decisions.

When the list is exhausted (or the user says "stop"), print a summary:
total violations, how many fixed, how many declined (with reasons if
given), and remind the user that step 8 (re-audit) is next if any fixes
were applied.

This is the high-value step — the report is useful, but engineering teams
want diffs.

### 8. Re-audit after fixes

If any source edits were applied in step 7, rerun the audit from step 4 so
that the findings report and VPAT reflect the **post-fix state** — a
conformance report based on the pre-fix snapshot is misleading. Overwrite
the prior `./wcag-audit/aggregated.json` (or `audit-<ts>.json` for single-URL)
and rerun `score.mjs` against the new result.

If no edits were applied in step 7 (report-only run), skip this step.

Diff the new `aggregated.json` against the prior one to confirm violations
were fixed and none regressed.

### 9. Generate the findings report

```bash
node scripts/report-generate.mjs \
  --aggregated ./wcag-audit/aggregated.json \
  --score ./wcag-audit/score.json
# writes ./wcag-audit/report.md
```

Deterministic markdown — same inputs produce byte-identical output. Safe to
diff between runs, commit to the repo, or publish. Reflects the most recent
audit (post-fix if step 8 ran).

### 10. Generate the VPAT ACR (mandatory prompt)

**You MUST prompt the user via `AskUserQuestion` whether to generate a
formal Accessibility Conformance Report, even if they did not mention it.**
A findings report (step 9) is *not* the same artifact as a VPAT/ACR — ACRs
are the deliverable procurement and legal teams expect. Never silently
skip this step.

Present three options:

- **Skip** — the findings report is sufficient for our purposes.
- **Worksheet only** — markdown table (`./wcag-audit/ACR-<product>-<date>-worksheet.md`),
  no ITI template required. Fast, always works, good for internal review.
- **Full .docx ACR** — fills in a user-supplied ITI VPAT 2.5 INT `.docx`
  template. Best-effort table population; worksheet companion also produced.
  User must download the template from
  <https://www.itic.org/policy/accessibility/vpat> first — this skill does
  not redistribute it.

If the user picks Worksheet or Full .docx, also collect `--product "<name>"`
and `--version "<v>"` via `AskUserQuestion` before running (both are
required by `vpat-fill.mjs`).

Commands:

```bash
# Worksheet mode
node scripts/vpat-fill.mjs \
  --aggregated ./wcag-audit/aggregated.json \
  --score ./wcag-audit/score.json \
  --product "MyApp" --version "1.0"
# writes ./wcag-audit/ACR-MyApp-<date>-worksheet.md

# .docx mode (user-supplied ITI template)
node scripts/vpat-fill.mjs \
  --aggregated ./wcag-audit/aggregated.json \
  --score ./wcag-audit/score.json \
  --product "MyApp" --version "1.0" \
  --template ./VPAT2.5INT.docx
# writes ./wcag-audit/ACR-MyApp-<date>.docx + companion worksheet
```

After running, report the absolute output path(s) to the user.

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
