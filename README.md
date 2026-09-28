# Runway: three-bucket edition, with Monte Carlo

A local-first retirement calculator that answers two questions:

> **1. How should my money be split between capital preservation, high income, and global equities?**
>
> **2. Do I have enough to last the rest of my life? In how many of 1,000 simulated futures does the plan work, and if not enough, how much more do I need today?**

This is the `monte-carlo` branch. The `main` branch is the simpler expected-return version (with rental properties and stress tests).

Adapted from [haiguan28/financial-runway-calculator](https://github.com/haiguan28/financial-runway-calculator) (MIT). The original answers "how much must I earn, until when?"; this version answers with the split and the gap instead.

## Quickstart

```bash
npm install
npm start
```

Open the printed `http://localhost:4207`. The app starts with obviously fake example data, and nothing is saved until your first edit. Your data lives in `~/runway-data` (change with `--data-dir` or `RUNWAY_DATA_DIR`), never in this repo. A plan saved by the original app is converted automatically the first time this version opens it (a snapshot of the old version is kept).

## What it models

- **Dollars.** You enter amounts in today's dollars. The engine runs in actual future dollars with one **inflation** input (default 2.5%), and shows every result back in today's dollars.
- **Rates are actual rates, before inflation.** Each spending line, income stream, and contribution can have its own yearly increase. Leave it blank to rise with inflation.
- **Accounts, by tax treatment.** Taxable brokerage, traditional IRA, 401(k), and Roth IRA, each with a balance and optional yearly contributions plus employer match for a set number of years (for a 401(k) still being funded).
- **Bucket plan or own fund.** Each account either follows the recommended split or sits in its own fund at its own return (for money you leave alone, like a 401(k) in a target-date fund; default 7% before inflation). Own-fund money isn't part of the split; it counts as long-term money, so it lowers how much the bucket plan holds in equities.
- **One plan-to age for both of you.** You and a spouse each live to the plan-to age; the plan runs until the younger of you reaches it. Each person's Social Security and healthcare stop after that age, and the survivor keeps the larger of the two Social Security checks. Household spending doesn't drop after a death (conservative).
- **Three investment buckets.** Default returns before inflation: capital preservation 3%, high income 6%, global equities 8%, close to 2026 professional forecasts. All editable.
- **The split rule.** Withdrawals needed in years 1 through 8 sit in capital preservation, years 9 through 15 in high income, and everything after that in global equities (both cutoffs editable). Each future withdrawal is valued at what it costs today, following the path its money takes through the buckets. The buckets fill in that order, so capital preservation holds exactly your next 8 years of withdrawals, a fixed cushion rather than a share of the total. With more than 15 years left, everything else goes to equities; with 9 to 15 years left, everything else goes to high income; with 8 or fewer, everything is in capital preservation. If the plan is short, the later buckets are short first. The split is redone every year as withdrawals get closer.
- **Simulated futures (Monte Carlo).** The plan runs through 1,000 futures. Each year, each bucket's return is drawn at random: the expected return is what money compounds at in a typical future, and a "typical yearly swing" (volatility) sets how bumpy the years are. Defaults: capital preservation 1%, high income 8%, global equities 17%, a target-date own fund 15%, a little cautious vs. the averages investment firms use (cash 1.1%, core bonds 5.9%, high yield 9.9%, US stocks 16.5%, international 18.1%, per the Horizon Actuarial survey). Equities and high income move together (correlation 0.5); an own fund follows equities (0.9). Inflation is fixed. The draws are seeded, so the same inputs always give the same answer.
- **The refill rule.** The buckets hold real balances. Withdrawals come out of capital preservation first, then high income. After a year equities rose, the buckets are refilled to their targets; after a year equities fell, nothing is sold to refill, so equities get time to recover.
- **Results.** Chance of success (the share of futures that reach your goal), the gap (how much more invested today would lift it to your target, default 90%), and the 50% / 80% / 90% outcomes (balances that half, 80%, and 90% of futures end at least as well as), for the base case and for spending 20% higher. The recommended split and the by-age table use expected returns so they're easy to read.
- **Taxes on withdrawals.** Money comes out of taxable first, then traditional IRA / 401(k), then Roth, grossed up so the after-tax cash covers spending:
  - *Taxable:* capital-gains rate × the gain share of what's sold. The app tracks your **cost basis** in dollars: growth raises the value but not the basis, so the taxed share rises over time, and a sale lowers the basis in proportion (average cost). Inflation alone creates taxable gain, as it does in real life.
  - *Traditional IRA / 401(k):* ordinary income rate on the whole withdrawal, plus a 10% penalty before age 59½ (flagged in the results).
  - *Roth:* tax-free. Withdrawals before 59½ are flagged, not modeled.
- **Everything else from the original:** Social Security with a trust-fund haircut, pre- and post-65 healthcare, a spouse and dependents, spending windows, three end goals (die with zero, leave a bequest, never drop below a floor), saved scenarios, snapshots, trends, and spreadsheet import/export. Rental properties and the old stress tests are removed in this branch; a saved plan's rentals are dropped when it's first opened here.

### Known simplifications

- **No required minimum distributions** (slightly optimistic). **No tax brackets**: one effective rate each. **Rebalancing is tax-free.** **Every bucket-plan account holds the same mix.** **Inflation doesn't vary.** Returns are lognormal, so real markets' occasional extreme years are somewhat more common than the model assumes. Income is entered after tax.

## Privacy posture and threat model

- **Your data never enters this repo** and never leaves your machine. All state lives in your data directory as human-readable JSON. Copying that directory is a complete backup.
- **Zero network egress, enforced not asserted**: a test scans the source for outbound-network APIs (`test/egress.test.mjs`), and the served UI carries a strict Content-Security-Policy that blocks any remote request.
- **The server binds 127.0.0.1 only** and defends against browser-origin attacks (DNS rebinding, cross-site requests against localhost) with Host and Origin validation, no CORS headers ever, and content-type + size enforcement.
- **The trust boundary is the filesystem.** Processes running as your user can read your data directory directly; no API token would change that. The defenses above target the real remote vector — a malicious web page in your own browser.
- Data directories get a `.gitignore` (`*`) and a README on creation so real numbers can't be accidentally committed or shared; startup warns if the directory sits inside a cloud-synced folder.

## Development

```bash
npm test          # node:test suites: engine/solver/store/API, the egress guard, and a headless-Chrome render smoke test
npm run typecheck # tsc --noEmit over JSDoc types in src/
```

The render smoke test (`test/smoke-render.test.mjs`) boots the server and loads the app in real headless Chrome, asserting it actually paints and that no resource fails to load — it catches browser-only breakage (e.g. a UI module importing a path the server doesn't serve) that Node-only tests miss. It needs Chrome/Chromium; set `RUNWAY_CHROME` to override discovery. Locally it skips if Chrome isn't found; in CI a missing Chrome is a hard failure so the smoke test can't silently skip.

Vanilla ESM JavaScript, Node core `http`, `node:test`, hand-rolled SVG charts. Runtime dependencies are limited to two import parsers (spreadsheet + CSV); the pinned spreadsheet-parser version is a deliberate supply-chain decision — see comments in `package.json` before bumping.
