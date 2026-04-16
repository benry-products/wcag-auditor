# WCAG Auditor — Claude Code Skill

Audit your own web application for **WCAG 2.2 Level AA** accessibility
compliance, directly from a Claude Code conversation.

- Runs [axe-core](https://github.com/dequelabs/axe-core) via Playwright against
  any URL — public or **authenticated**
- Maps violations to specific WCAG success criteria
- Claude reads your source repo and proposes **concrete Edit diffs** as fixes
- Produces a deterministic markdown **findings report**
- Optionally fills in a user-supplied ITI **VPAT 2.5 INT** template to produce a
  formal Accessibility Conformance Report (ACR)

**Primary use case:** auditing your own web app. The skill assumes Claude can
read your source to locate and fix violations.

## Install

This repo ships as both a Claude Code plugin (via a one-plugin marketplace) and
a standalone skill. Pick whichever fits your workflow.

### Requirements (all install paths)

- **Node.js >= 22** (current active LTS) — the only thing the user installs
  themselves
- Runtime dependencies (`playwright`, `axe-core`, etc.) and the Playwright
  Chromium binary are **installed automatically by Claude on first use**. If
  you intend to run the CLI scripts directly (`npm run audit`, etc.) without
  Claude, run `npm install && npx playwright install chromium` in the
  installed plugin root once.

### Option 1 — Claude Code plugin marketplace (recommended)

From any Claude Code session:

```
/plugin marketplace add benry-products/wcag-auditor
/plugin install wcag-auditor@wcag-auditor-tools
```

Then install the runtime dependencies once. The plugin is cached at
`~/.claude/plugins/cache/` — find the actual path from the install output,
then:

```bash
cd <cached-plugin-path>/skills/wcag-auditor
npm install
npx playwright install chromium
```

Skills invoked from the plugin are namespaced as `wcag-auditor:*`.

### Option 2 — Skillsmith CLI

```bash
npx -y @skillsmith/cli install github:benry-products/wcag-auditor
cd ~/.claude/skills/wcag-auditor
npm install
npx playwright install chromium
```

Requires [`@skillsmith/cli`](https://www.skillsmith.app/). Handles download +
installation to `~/.claude/skills/` automatically.

### Option 3 — Manual skill copy

```bash
git clone https://github.com/benry-products/wcag-auditor.git
cp -r wcag-auditor/skills/wcag-auditor ~/.claude/skills/
cd ~/.claude/skills/wcag-auditor
npm install
npx playwright install chromium
```

The simplest path — no tooling beyond `git` and `npm`. Works offline after the
initial clone and `npm install`.

### Option 4 — Local plugin-dir session (dev / testing)

For trying the plugin without a persistent install:

```bash
git clone https://github.com/benry-products/wcag-auditor.git
cd wcag-auditor && npm install && npx playwright install chromium
claude --plugin-dir ./
```

The plugin is active only for that Claude Code session.

## Quick start

From any Claude Code session:

> audit https://my-app.example.com for WCAG 2.2 AA

Claude will trigger the skill, clarify scope, and run the audit. For
authenticated routes, Claude will walk you through generating an `auth.json`
session-state file via a one-time headed login.

## CLI usage (direct)

The scripts are also runnable directly:

```bash
# Single URL
npm run audit -- --url https://example.com --out ./audit.json

# Multi-page via sitemap + explicit list
npm run audit:site -- \
  --sitemap https://example.com/sitemap.xml \
  --urls ./urls.txt \
  --auth ./auth.json \
  --out ./audit/

# Generate markdown findings report
npm run report -- --aggregated ./audit/aggregated.json --out ./report.md

# Optional: fill a user-supplied ITI VPAT 2.5 INT template
npm run vpat:fill -- \
  --template ./VPAT2.5INT.docx \
  --aggregated ./audit/aggregated.json \
  --product "MyApp" --version "1.0"
```

See `skills/wcag-auditor/SKILL.md` for the full workflow and flag reference.

## What's in scope (v0.1.0)

- WCAG 2.2 Level AA by default; Level AAA opt-in via `--level AAA`
- Public + `storageState`-authenticated routes
- Sitemap + explicit URL list + bounded seeded crawl
- Findings mapped to Section 508 and EN 301 549 via published crosswalks
- Markdown findings report (deterministic)
- VPAT 2.5 INT `.docx` fill-in (user supplies template)

## What's out of scope (for v0.1.0)

- Bearer-token / basic-auth / custom-header authentication
- Framework route-manifest parsers (recipes for Next.js/Rails/etc. documented
  instead — see `references/url-discovery.md`)
- Baseline / suppressions file
- Independent evaluation of 508 or EN 301 549 (derived from WCAG findings only)

## VPAT template

This repo **does not redistribute** the ITI VPAT template. The VPAT name and
form are registered service marks of the Information Technology Industry
Council (ITI). To produce a formal VPAT 2.5 INT ACR, download the current
template directly from
[itic.org/policy/accessibility/vpat](https://www.itic.org/policy/accessibility/vpat),
then pass its path to `vpat-fill.mjs`.

## Troubleshooting

### "I pushed a fix but Claude is still running old behavior"

Plugin installs are cached under `~/.claude/plugins/cache/…/<version>/` and
refreshed only when the plugin manager pulls a newer version from the
marketplace. If the marketplace clone itself is stale (e.g., its git remote
points at a transferred repo, or `/plugin` hasn't been asked to update), you
can keep running an old version indefinitely.

The scripts now log their version to stderr on startup
(`audit.mjs v0.1.2`, etc.). If that number doesn't match the latest
[plugin.json](./.claude-plugin/plugin.json) on `main`, your cache is stale.

To force a refresh:

```bash
# 1. Pull the marketplace clone
cd ~/.claude/plugins/marketplaces/wcag-auditor-tools
git remote -v                                   # verify origin is benry-products
git remote set-url origin https://github.com/benry-products/wcag-auditor.git   # if wrong
git pull --ff-only

# 2. In a Claude Code session, run `/plugin` and update wcag-auditor.
#    Or, as a manual fallback, mirror the marketplace into the cache:
rsync -a --delete \
  ~/.claude/plugins/marketplaces/wcag-auditor-tools/skills/ \
  ~/.claude/plugins/cache/wcag-auditor-tools/wcag-auditor/<version>/skills/
```

After this, the next skill invocation will print the new version in the
banner and run the current code.

## License

MIT — see `LICENSE`.
