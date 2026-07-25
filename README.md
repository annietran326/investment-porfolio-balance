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

- **Deterministic year-by-year simulation in today's dollars.** Returns are *real* (after inflation and tax on reinvested returns) — a single knob, no black-box Monte Carlo. Every assumption is visible and editable. Convention: growth applies to the prior balance, then the year's net cash flow lands (arrival-year cash earns no return).
- **Real estate as a first-class asset**: per-property rent, costs, mortgage P&I, payoff year, optional sale year and net proceeds. An empty sale year means keep forever.
- **A required-income solver**: bisection over annual income until the terminal balance hits your end-state target. Three-way answer: already met / earn $X per year until age Y / not achievable even at the cap.
- **Named stress scenarios**: simultaneous vacancy + major repair + delayed sale; market −30%; spending +20%; everything at once. Runway and required income are reported per scenario.
- **Household**: model a spouse (their own Social Security and healthcare, on their own age) and dependents. Dependents mainly drive time-boxed expenses — the tool has no death/survivor modeling.
- **Per-line real growth**: rents, income, and expenses can grow faster or slower than inflation. A growth rate of 0 (the default) means "grows with inflation" — it holds constant in today's dollars, exactly the base behavior. Positive outpaces inflation, negative lags it; growth compounds from the current year. This keeps everything in today's dollars — no separate inflation input to double-count.
- **Expense windows**: each spending line has optional start/end years. Perpetual costs (food) leave them blank; time-boxed costs (a dependent, a car loan, tuition) stop on schedule.
- **Assumptions with sourced 2026 defaults** (all editable, all dated — see the in-app panel): Social Security haircut 25% (2026 Trustees Report projects a 22–28% cut at 2032 depletion), pre-65 healthcare $16,000/yr (unsubsidized ACA anchor, state-dependent), Medicare-age $7,500/yr, real return 3.5% (forward-looking capital-market assumptions for a balanced portfolio), plan-to-age presets 90/95/100.
- **Optional tax on forced investment sales** (off by default): flip it on in the Portfolio panel and any year the plan must sell investments to cover a spending shortfall is charged an effective capital-gains rate on the gain portion of the sale, grossed-up so spending is still funded. Income and property proceeds stay net-of-tax (you enter net figures), and the real-return knob already nets tax on reinvested returns — this adds only the realized-gains tax the base model left out. Two knobs: the blended effective rate and the taxable-gain share of each withdrawal. It is an *effective-rate assumption, not a full tax engine* — account types (taxable/traditional/Roth), progressive brackets, RMDs, and cost-basis tracking are deliberately out of scope.

**A known, documented bias**: mortgage P&I is fixed in *nominal* dollars, but the simulation runs in *real* dollars, so late-year mortgage costs are overstated. The direction is conservative (the tool will tell you to earn slightly more, never less). See the engine's doc comments.

## How the withdrawal tax works

When it's enabled, the tax models one thing the base model skips: the years your spending outruns your income, you sell investments to cover the gap — and selling realizes capital gains, which are taxed. The subtlety is that you have to sell enough to cover **both** the spending *and* the tax on the sale.

Two knobs drive it (defaults 18% / 50%; the worked example below uses **20% rate × 50% gain** for clean arithmetic):

- **effective capital-gains rate** `r` — your blended federal + state rate on realized gains
- **taxable-gain share** `g` — how much of each withdrawn dollar is gain (vs. return of your original basis)

Say a year is short **$90,000**. Selling exactly $90,000 doesn't work: half is gain ($45,000), taxed at 20% = $9,000, so you'd pocket only $81,000 — still short. So the model *grosses up* the sale:

```
combined gain-tax rate   k = g × r = 0.50 × 0.20 = 0.10   (10%)

sell   W = shortfall / (1 − k) = $90,000 / 0.90 = $100,000
tax      = W − shortfall       = $100,000 − $90,000 = $10,000
```

You sell $100,000, pay $10,000 in tax, keep $90,000 to live on — and the portfolio drops by the full $100,000. On a $1,000,000 portfolio at 0% real return spending $90,000/yr, that's the difference between draining $90k/yr (tax off) and $100k/yr (tax on) — about **$50,000 more depleted over 5 years**, which is why enabling it raises your required-income answer.

**Two boundaries keep it honest:**

- **You're only taxed on what you actually sell.** If the account holds $50,000 but the year needs $90,000, the sale is capped at $50,000 — tax is `$50,000 × 50% × 20% = $5,000`, not the tax on a $100,000 sale you couldn't make. You can't realize gains on assets you don't own.
- **No double-counting with the return knob.** The real-return knob's "after tax" is the drag on *reinvested* returns; this layer is the tax on *realized gains from forced sales* — genuinely separate events. Income and property proceeds are entered net of tax, so they're never touched here.

It's an *effective-rate assumption, not a full tax engine* — account types, progressive brackets, RMDs, and cost-basis tracking are deliberately out of scope (see "What it models" above).

## Privacy posture and threat model

- **Your data never enters this repo** and never leaves your machine. All state lives in your data directory as human-readable JSON. Copying that directory is a complete backup.
- **Zero network egress, enforced not asserted**: a test scans the source for outbound-network APIs (`test/egress.test.mjs`), and the served UI carries a strict Content-Security-Policy that blocks any remote request.
- **The server binds 127.0.0.1 only** and defends against browser-origin attacks (DNS rebinding, cross-site requests against localhost) with Host and Origin validation, no CORS headers ever, and content-type + size enforcement.
- **The trust boundary is the filesystem.** Processes running as your user can read your data directory directly; no API token would change that. The defenses above target the real remote vector — a malicious web page in your own browser.
- Data directories get a `.gitignore` (`*`) and a README on creation so real numbers can't be accidentally committed or shared; startup warns if the directory sits inside a cloud-synced folder.

## Development

```bash
npm test          # node:test suites — engine/solver/store/API, the egress guard, and a headless-Chrome render smoke test
npm run typecheck # tsc --noEmit over JSDoc types in src/
```

The render smoke test (`test/smoke-render.test.mjs`) boots the server and loads the app in real headless Chrome, asserting it actually paints and that no resource fails to load — it catches browser-only breakage (e.g. a UI module importing a path the server doesn't serve) that Node-only tests miss. It needs Chrome/Chromium; set `RUNWAY_CHROME` to override discovery. Locally it skips if Chrome isn't found; in CI a missing Chrome is a hard failure so the smoke test can't silently skip.

Vanilla ESM JavaScript, Node core `http`, `node:test`, hand-rolled SVG charts. Runtime dependencies are limited to two import parsers (spreadsheet + CSV); the pinned spreadsheet-parser version is a deliberate supply-chain decision — see comments in `package.json` before bumping.
