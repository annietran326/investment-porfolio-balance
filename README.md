# Runway

A local-first runway / die-with-zero retirement calculator that answers one question:

> **Do I still need to work — and if so, how much must I earn per year, until when?**

Most retirement calculators solve the forward direction: given a savings rate, when can you retire? Runway inverts it. Given what you already have — including rental real estate with mortgages and planned sales — it solves for the **required income**: the minimum net dollars per year, over a working window you choose, to land exactly on your chosen ending (die with zero, leave a bequest, or never drop below a floor).

## Quickstart

```bash
git clone <this-repo>
cd runway
npm install
npm start
```

Open the printed `http://localhost:4207`. The app starts with obviously fake example data — nothing is saved until your first edit. Your data lives in `~/runway-data` (change with `--data-dir` or `RUNWAY_DATA_DIR`), never in this repo.

## What it models

- **Deterministic year-by-year simulation in today's dollars.** Returns are *real* (after inflation and tax) — a single knob, no black-box Monte Carlo. Every assumption is visible and editable. Convention: growth applies to the prior balance, then the year's net cash flow lands (arrival-year cash earns no return).
- **Real estate as a first-class asset**: per-property rent, costs, mortgage P&I, payoff year, optional sale year and net proceeds. An empty sale year means keep forever.
- **A required-income solver**: bisection over annual income until the terminal balance hits your end-state target. Three-way answer: already met / earn $X per year until age Y / not achievable even at the cap.
- **Named stress scenarios**: simultaneous vacancy + major repair + delayed sale; market −30%; spending +20%; everything at once. Runway and required income are reported per scenario.
- **Assumptions with sourced 2026 defaults** (all editable, all dated — see the in-app panel): Social Security haircut 25% (2026 Trustees Report projects a 22–28% cut at 2032 depletion), pre-65 healthcare $16,000/yr (unsubsidized ACA anchor, state-dependent), Medicare-age $7,500/yr, real return 3.5% (forward-looking capital-market assumptions for a balanced portfolio), plan-to-age presets 90/95/100.

**A known, documented bias**: mortgage P&I is fixed in *nominal* dollars, but the simulation runs in *real* dollars, so late-year mortgage costs are overstated. The direction is conservative (the tool will tell you to earn slightly more, never less). See the engine's doc comments.

## Privacy posture and threat model

- **Your data never enters this repo** and never leaves your machine. All state lives in your data directory as human-readable JSON. Copying that directory is a complete backup.
- **Zero network egress, enforced not asserted**: a test scans the source for outbound-network APIs (`test/egress.test.mjs`), and the served UI carries a strict Content-Security-Policy that blocks any remote request.
- **The server binds 127.0.0.1 only** and defends against browser-origin attacks (DNS rebinding, cross-site requests against localhost) with Host and Origin validation, no CORS headers ever, and content-type + size enforcement.
- **The trust boundary is the filesystem.** Processes running as your user can read your data directory directly; no API token would change that. The defenses above target the real remote vector — a malicious web page in your own browser.
- Data directories get a `.gitignore` (`*`) and a README on creation so real numbers can't be accidentally committed or shared; startup warns if the directory sits inside a cloud-synced folder.

## Development

```bash
npm test          # node:test suites, includes the egress guard
npm run typecheck # tsc --noEmit over JSDoc types in src/ (public/ DOM layer is manual-verification; see plan risks)
```

Vanilla ESM JavaScript, Node core `http`, `node:test`, hand-rolled SVG charts. Runtime dependencies are limited to two import parsers (spreadsheet + CSV); the pinned spreadsheet-parser version is a deliberate supply-chain decision — see comments in `package.json` before bumping.
