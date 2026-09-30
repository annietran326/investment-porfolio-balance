// Pure-logic UI tests (U6): verdict copy, formatting, form transforms, and
// the save pipeline state machine. No DOM — public/ui/*.mjs must load under
// plain Node (no DOM globals at module top level), which this file enforces
// by importing them.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mcVerdictCopy,
  expectedLine,
  gapCell,
  fmtPct,
  goalText,
  fmtMoney,
  fmtCompact,
  yearDelta,
  runwayCell,
} from "../public/ui/verdict.mjs";
import { createDebouncer, createSavePipeline, putState } from "../public/ui/save.mjs";
import {
  addRow,
  removeRow,
  setRowValue,
  setValueAtPath,
  setEndStateMode,
  setEndStateAmount,
  endStateAmountValue,
  parseNumField,
  parseRowField,
  gainShareOf,
  addPerson,
  removePerson,
  setPersonField,
} from "../public/ui/forms.mjs";
import { placeholderState } from "../src/model/placeholder.mjs";
import { validate, defaultState, newPerson } from "../src/model/schema.mjs";

// ---------------------------------------------------------------------------
// harness: fake timers + a fake /api/state server honoring the rev contract
// ---------------------------------------------------------------------------

function fakeTimers() {
  let now = 0;
  let seq = 0;
  const timers = new Map();
  return {
    setTimer: (fn, ms) => {
      seq += 1;
      timers.set(seq, { at: now + ms, fn });
      return seq;
    },
    clearTimer: (h) => {
      timers.delete(h);
    },
    advance(ms) {
      now += ms;
      for (const [h, t] of [...timers.entries()].sort((a, b) => a[1].at - b[1].at)) {
        if (t.at <= now) {
          timers.delete(h);
          t.fn();
        }
      }
    },
  };
}

/** In-memory server: 200+rev bump when baseRev matches, else 409 {rev}. */
function makeServer(initialRev = 0) {
  let rev = initialRev;
  const calls = [];
  return {
    calls,
    rev: () => rev,
    fetchFn: async (url, init) => {
      const body = JSON.parse(init.body);
      const call = { url, baseRev: body.baseRev, state: body.state, keepalive: init.keepalive === true, status: 0 };
      calls.push(call);
      if (body.baseRev !== rev) {
        call.status = 409;
        const conflictRev = rev;
        return { status: 409, json: async () => ({ rev: conflictRev }) };
      }
      rev += 1;
      const okRev = rev;
      call.status = 200;
      return { status: 200, json: async () => ({ rev: okRev, warnings: [] }) };
    },
  };
}

/** Gate a fetchFn so each request stays in flight until release(). */
function gated(server) {
  const gates = [];
  return {
    fetchFn: (url, init) =>
      new Promise((resolve, reject) => {
        gates.push(() => server.fetchFn(url, init).then(resolve, reject));
      }),
    release: () => gates.shift()?.(),
  };
}

const settle = () => new Promise((r) => setImmediate(r));

function makePipeline({ server, initialRev = 0 } = {}) {
  const srv = server ?? makeServer();
  const timers = fakeTimers();
  const statuses = [];
  const pipeline = createSavePipeline({
    fetchFn: srv.fetchFn,
    initialRev,
    debounceMs: 1500,
    onState: (s) => statuses.push(s.status),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  return { srv, timers, statuses, pipeline };
}

// ---------------------------------------------------------------------------
// verdict copy — three-way, never blank
// ---------------------------------------------------------------------------

const mc = (/** @type {number} */ rate, /** @type {any} */ gap) => ({ successRate: rate, gap, end: { p50: 1_234_000, p90: 456_000 }, runs: 1000 });

test("mcVerdictCopy: yes at or above the target; the gap when below; never blank", () => {
  const s = placeholderState(); // target 90%
  const yes = mcVerdictCopy(mc(0.94, { kind: "met" }), s);
  assert.equal(yes.tone, "good");
  assert.match(yes.headline, /^Yes, you have enough: the plan works in 94% of 1,000 simulated futures/);
  assert.match(yes.detail, /\$1,234,000/);
  assert.match(yes.detail, /\$456,000/);
  const no = mcVerdictCopy(mc(0.36, { kind: "value", amount: 747_000 }), s);
  assert.equal(no.tone, "bad");
  assert.match(no.headline, /works in 36%.*gap is \$747,000/);
  assert.match(no.detail, /90% target/);
  const never = mcVerdictCopy(mc(0.01, { kind: "unreachable", cap: 50_000_000 }), s);
  assert.equal(never.tone, "bad");
  for (const c of [yes, no, never]) assert.ok(c.headline.length > 0);
  assert.equal(new Set([yes.headline, no.headline, never.headline]).size, 3);
});

test("mcVerdictCopy follows the success target", () => {
  const s = placeholderState();
  s.simulation.targetSuccessPct = 80;
  assert.equal(mcVerdictCopy(mc(0.85, { kind: "met" }), s).tone, "good", "85% clears an 80% target");
});

test("expectedLine: one line on the every-year-average plan", () => {
  const s = placeholderState();
  assert.match(expectedLine({ endBal: 500_000, firstBreachYear: null, startYear: 2026 }, { kind: "met" }, s), /the plan works, ending with \$500,000/);
  assert.match(expectedLine({ endBal: -5, firstBreachYear: 2064, startYear: 2026 }, { kind: "value", amount: 160_000 }, s), /runs out at age 83 \(2064\), and \$160,000 more today/);
});

test("gapCell: never blank; colour per kind", () => {
  assert.deepEqual(gapCell({ kind: "met" }), { text: "none", cls: "pos" });
  assert.deepEqual(gapCell({ kind: "value", amount: 120_000 }), { text: "$120,000", cls: "warn" });
  assert.equal(gapCell({ kind: "unreachable", cap: 50_000_000 }).cls, "neg");
});

test("fmtPct rounds to whole percents", () => {
  assert.equal(fmtPct(0.3412), "34%");
  assert.equal(fmtPct(0), "0%");
  assert.equal(fmtPct(1), "100%");
});

test("goalText follows the end-state mode and its own amount", () => {
  const s = placeholderState();
  assert.equal(goalText(s), "die with zero");
  const bequest = setEndStateAmount(setEndStateMode(s, "bequest"), 500_000);
  assert.equal(goalText(bequest), "leave $500,000");
  const floor = setEndStateAmount(setEndStateMode(s, "floor"), 250_000);
  assert.equal(goalText(floor), "never drop below $250,000");
});

test("runwayCell: finite breach year is red with years-from-now; never is green", () => {
  // Consumes firstBreachYear (below $0, or below the floor in floor mode) —
  // NOT firstNegYear, so floor-mode runway respects the floor.
  assert.deepEqual(runwayCell({ firstBreachYear: 2043, startYear: 2026 }), { text: "2043 (17 yrs)", cls: "neg" });
  assert.deepEqual(runwayCell({ firstBreachYear: null, startYear: 2026 }), { text: "never runs out", cls: "pos" });
});

// ---------------------------------------------------------------------------
// end-state amounts round-trip
// ---------------------------------------------------------------------------

test("end-state amounts round-trip: zero→bequest→floor→bequest preserves each mode's amount", () => {
  const s0 = placeholderState(); // starts in zero mode
  const before = structuredClone(s0);
  let s = setEndStateMode(s0, "bequest");
  s = setEndStateAmount(s, 500_000);
  s = setEndStateMode(s, "floor");
  s = setEndStateAmount(s, 120_000);
  s = setEndStateMode(s, "bequest");
  assert.equal(s.endState.amounts.bequest, 500_000, "bequest amount preserved across switches");
  assert.equal(endStateAmountValue(s), 500_000);
  s = setEndStateMode(s, "floor");
  assert.equal(endStateAmountValue(s), 120_000, "floor amount preserved across switches");
  s = setEndStateMode(s, "zero");
  assert.equal(endStateAmountValue(s), null, "zero has no amount — input hidden");
  assert.deepEqual(s.endState.amounts, { bequest: 500_000, floor: 120_000 }, "amounts survive zero");
  assert.deepEqual(s0, before, "input state never mutated");
});

test("setEndStateAmount in zero mode is a no-op on amounts", () => {
  const next = setEndStateAmount(placeholderState(), 999);
  assert.deepEqual(next.endState.amounts, { bequest: 0, floor: 0 });
});

// ---------------------------------------------------------------------------
// save pipeline state machine
// ---------------------------------------------------------------------------

test("save: a burst of edits collapses to ONE PUT carrying the latest payload", async () => {
  const { srv, timers, statuses, pipeline } = makePipeline();
  pipeline.edit({ n: 1 });
  timers.advance(1000);
  pipeline.edit({ n: 2 });
  timers.advance(1000);
  pipeline.edit({ n: 3 });
  timers.advance(1500);
  await settle();
  assert.equal(srv.calls.length, 1, "burst collapsed");
  assert.equal(srv.calls[0].state.n, 3, "latest payload wins");
  assert.equal(srv.calls[0].baseRev, 0);
  assert.equal(pipeline.snapshot().status, "saved");
  assert.ok(statuses.includes("saving"), "went through saving");
});

test("save: response rev threads into the next PUT — no self-409 on bursts", async () => {
  const srv = makeServer();
  const gate = gated(srv);
  const timers = fakeTimers();
  const pipeline = createSavePipeline({
    fetchFn: gate.fetchFn,
    initialRev: 0,
    debounceMs: 1500,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  pipeline.edit({ n: 1 });
  timers.advance(1500); // PUT 1 starts, held in flight
  pipeline.edit({ n: 2 }); // latest payload queues behind it
  timers.advance(1500); // debounce fires — but only one PUT may fly
  gate.release(); // PUT 1 completes (rev 0 → 1)
  await settle();
  gate.release(); // queued PUT 2 auto-fires with the fresh rev
  await settle();
  assert.equal(srv.calls.length, 2, "serialized: exactly two PUTs");
  assert.deepEqual(srv.calls.map((c) => c.baseRev), [0, 1], "rev threaded");
  assert.deepEqual(srv.calls.map((c) => c.status), [200, 200], "no self-409");
  assert.equal(srv.calls[1].state.n, 2);
  assert.equal(pipeline.snapshot().status, "saved");
  assert.equal(pipeline.rev(), 2);
});

test("save: failed fetch → error; retry re-fires the LATEST payload, not the failed one", async () => {
  const srv = makeServer();
  let failures = 1;
  const fetchFn = async (url, init) => {
    if (failures > 0) {
      failures -= 1;
      throw new Error("network down");
    }
    return srv.fetchFn(url, init);
  };
  const timers = fakeTimers();
  const pipeline = createSavePipeline({
    fetchFn,
    initialRev: 0,
    debounceMs: 1500,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  pipeline.edit({ n: "a" });
  timers.advance(1500);
  await settle();
  assert.equal(pipeline.snapshot().status, "error");
  pipeline.edit({ n: "b" }); // arms a fresh debounce; error badge persists
  assert.equal(pipeline.snapshot().status, "error", "new edits keep the error (and Retry) visible");
  await pipeline.retry();
  assert.equal(srv.calls.length, 1);
  assert.equal(srv.calls[0].state.n, "b", "retry sent the latest payload");
  assert.equal(pipeline.snapshot().status, "saved");
  timers.advance(1500); // the still-armed debounce fires — nothing new to save
  await settle();
  assert.equal(srv.calls.length, 1, "no duplicate PUT after retry");
});

test("save: 409 → conflict state; the queue is cancelled and the pipeline goes inert", async () => {
  const srv = makeServer(5); // server is ahead of this tab
  const { timers, statuses, pipeline } = makePipeline({ server: srv });
  pipeline.edit({ n: 1 });
  timers.advance(1500);
  await settle();
  assert.equal(pipeline.snapshot().status, "conflict");
  assert.equal(pipeline.rev(), 5, "learned the server's rev");
  pipeline.edit({ n: 2 }); // ignored — only a reload recovers
  timers.advance(10_000);
  await settle();
  assert.equal(srv.calls.length, 1, "no further PUTs after conflict");
  const afterConflict = statuses.slice(statuses.indexOf("conflict") + 1);
  assert.ok(!afterConflict.includes("saving"), "conflict is terminal");
});

test("save: markInvalid blocks the PUT until a valid edit arrives", async () => {
  const { srv, timers, pipeline } = makePipeline();
  pipeline.edit({ n: 1 });
  pipeline.markInvalid("profile.endAge: must be a number");
  timers.advance(10_000);
  await settle();
  assert.equal(srv.calls.length, 0, "errors block the PUT");
  assert.equal(pipeline.snapshot().status, "invalid");
  assert.equal(pipeline.snapshot().message, "profile.endAge: must be a number");
  pipeline.edit({ n: 2 }); // fixed
  timers.advance(1500);
  await settle();
  assert.equal(srv.calls.length, 1);
  assert.equal(srv.calls[0].state.n, 2);
  assert.equal(pipeline.snapshot().status, "saved");
});

test("save: flushOrCancel flushes a pending debounced edit immediately", async () => {
  const { srv, timers, pipeline } = makePipeline();
  pipeline.edit({ n: 7 });
  const snap = await pipeline.flushOrCancel(); // no timer advance needed
  assert.equal(srv.calls.length, 1);
  assert.equal(snap.status, "saved");
  timers.advance(10_000);
  await settle();
  assert.equal(srv.calls.length, 1, "debounce disarmed — no duplicate PUT");
});

test("save: flushKeepalive sends the pending edit with keepalive:true", async () => {
  const { srv, pipeline } = makePipeline();
  pipeline.edit({ n: 9 });
  pipeline.flushKeepalive();
  await settle();
  assert.equal(srv.calls.length, 1);
  assert.equal(srv.calls[0].keepalive, true);
});

test("save: cancel drops the pending queue (nothing fires later)", async () => {
  const { srv, timers, pipeline } = makePipeline();
  pipeline.edit({ n: 1 });
  pipeline.cancel();
  timers.advance(10_000);
  await settle();
  assert.equal(srv.calls.length, 0);
  assert.equal(pipeline.snapshot().dirty, false);
});

test("putState classifies 400 (with error paths) and 409 responses", async () => {
  const bad = await putState(
    async () => ({ status: 400, json: async () => ({ errors: [{ path: "profile.endAge", message: "bad" }] }) }),
    {},
    0
  );
  assert.deepEqual(bad, { kind: "error", message: "profile.endAge: bad" });
  const conflict = await putState(async () => ({ status: 409, json: async () => ({ rev: 7 }) }), {}, 0);
  assert.deepEqual(conflict, { kind: "conflict", rev: 7 });
});

// ---------------------------------------------------------------------------
// debounce helper
// ---------------------------------------------------------------------------

test("debounce: timer resets on new edits; flush fires immediately; cancel disarms", () => {
  const timers = fakeTimers();
  let fired = 0;
  const d = createDebouncer(1500, () => fired++, { setTimer: timers.setTimer, clearTimer: timers.clearTimer });
  d.arm();
  timers.advance(1000);
  d.arm();
  timers.advance(1000);
  assert.equal(fired, 0, "re-arming postpones the fire");
  timers.advance(500);
  assert.equal(fired, 1);
  d.arm();
  d.flush();
  assert.equal(fired, 2, "flush fires immediately");
  timers.advance(10_000);
  assert.equal(fired, 2, "flushed timer does not re-fire");
  d.arm();
  d.cancel();
  timers.advance(10_000);
  assert.equal(fired, 2, "cancel disarms");
});

// ---------------------------------------------------------------------------
// form row transforms — immutable, valid blanks
// ---------------------------------------------------------------------------

test("addRow: appends a valid blank row for each kind without mutating input", () => {
  const s = placeholderState();
  const before = structuredClone(s);
  const withIncome = addRow(s, "incomes");
  assert.deepEqual(withIncome.incomes.at(-1), { name: "new income", annual: 0, fromYear: 2026, toYear: 2030, growthPct: null });
  const withSpend = addRow(s, "spending");
  assert.deepEqual(withSpend.spending.at(-1), { name: "new category", monthly: 0, fromYear: null, toYear: null, growthPct: null, variable: true });
  for (const next of [withIncome, withSpend]) {
    assert.deepEqual(validate(next).errors, [], "blank rows validate cleanly");
  }
  assert.deepEqual(s, before, "input state never mutated");
});

test("removeRow: removes exactly the indexed row without mutating input", () => {
  const s = placeholderState();
  const before = structuredClone(s);
  const next = removeRow(s, "spending", 0);
  assert.equal(next.spending.length, s.spending.length - 1);
  assert.equal(next.spending[0].name, s.spending[1].name, "the right row was removed");
  assert.deepEqual(s, before);
});

test("setRowValue / setValueAtPath: immutable single-field updates", () => {
  const s = placeholderState();
  const before = structuredClone(s);
  const a = setRowValue(s, "spending", 0, "toYear", null);
  assert.equal(a.spending[0].toYear, null);
  const b = setValueAtPath(s, "profile.endAge", 100);
  assert.equal(b.profile.endAge, 100);
  assert.equal(b.accounts[0].balance, s.accounts[0].balance, "unrelated fields untouched");
  assert.deepEqual(s, before, "input state never mutated");
});

test("parseNumField: empty is null (meaningful), never coerced to 0", () => {
  assert.equal(parseNumField(""), null);
  assert.equal(parseNumField("  "), null);
  assert.equal(parseNumField("3.5"), 3.5);
  assert.equal(parseNumField("2027"), 2027);
  assert.ok(Number.isNaN(parseNumField("abc")), "garbage becomes NaN for validate() to reject");
});

// ---------------------------------------------------------------------------
// household people transforms — immutable, valid blanks, nested paths
// ---------------------------------------------------------------------------

test("addPerson: appends a valid spouse (seeds SS + healthcare) without mutating input", () => {
  const s = defaultState();
  const before = structuredClone(s);
  const next = addPerson(s, "spouse");
  assert.equal(next.household.people.length, s.household.people.length + 1);
  const spouse = next.household.people.at(-1);
  assert.equal(spouse.role, "spouse");
  assert.equal(spouse.currentAge, null);
  assert.ok(spouse.social && typeof spouse.social.startAge === "number", "spouse seeds Social Security");
  assert.ok(spouse.health && typeof spouse.health.preMedicareAnnual === "number", "spouse seeds healthcare");
  assert.deepEqual(validate(next).errors, [], "blank spouse validates cleanly");
  assert.deepEqual(s, before, "input state never mutated");
});

test("addPerson: appends a valid dependent (no SS/health) without mutating input", () => {
  const s = defaultState();
  const before = structuredClone(s);
  const next = addPerson(s, "dependent");
  const dep = next.household.people.at(-1);
  assert.equal(dep.role, "dependent");
  assert.equal(dep.currentAge, null);
  assert.equal(dep.social, undefined, "dependent carries no Social Security");
  assert.equal(dep.health, undefined, "dependent carries no healthcare");
  assert.deepEqual(validate(next).errors, [], "blank dependent validates cleanly");
  assert.deepEqual(s, before, "input state never mutated");
});

test("blank spouse/dependent from newPerson validate cleanly when added to a state", () => {
  const s = defaultState();
  s.household.people.push(newPerson("spouse"), newPerson("dependent"));
  assert.deepEqual(validate(s).errors, [], "both blanks are error-free");
});

test("removePerson: removes exactly the indexed person without mutating input", () => {
  const s = defaultState();
  s.household.people = [newPerson("spouse", { name: "A" }), newPerson("dependent", { name: "B" })];
  const before = structuredClone(s);
  const next = removePerson(s, 0);
  assert.equal(next.household.people.length, 1);
  assert.equal(next.household.people[0].name, "B", "the right person was removed");
  assert.deepEqual(s, before, "input state never mutated");
});

test("setPersonField: top-level and nested social/health paths, immutable", () => {
  const s = addPerson(defaultState(), "spouse");
  const before = structuredClone(s);
  // top-level
  const named = setPersonField(s, 0, "name", "Alex");
  assert.equal(named.household.people[0].name, "Alex");
  const aged = setPersonField(s, 0, "currentAge", 42);
  assert.equal(aged.household.people[0].currentAge, 42);
  // nested social + health
  const ss = setPersonField(s, 0, "social.startAge", 70);
  assert.equal(ss.household.people[0].social.startAge, 70);
  assert.equal(ss.household.people[0].social.monthly, s.household.people[0].social.monthly, "sibling field untouched");
  const hc = setPersonField(s, 0, "health.preMedicareAnnual", 20000);
  assert.equal(hc.household.people[0].health.preMedicareAnnual, 20000);
  // nested writes validate
  assert.deepEqual(validate(ss).errors, []);
  assert.deepEqual(validate(hc).errors, []);
  assert.deepEqual(s, before, "input state never mutated by any setter");
});

test("setPersonField: currentAge empty→null is a clean spouse-age warning, not an error", () => {
  const s = addPerson(defaultState(), "spouse");
  const cleared = setPersonField(s, 0, "currentAge", null);
  const { errors, warnings } = validate(cleared);
  assert.deepEqual(errors, [], "null spouse age is not an error");
  assert.ok(
    warnings.some((w) => w.path === "household.people[0].currentAge"),
    "null spouse age surfaces a warning"
  );
});

test("spending row: fromYear ''→null and increase ''→null (with inflation) round-trip and validate", () => {
  const s = defaultState();
  let next = addRow(s, "spending");
  const i = next.spending.length - 1;
  next = setRowValue(next, "spending", i, "name", "loan");
  next = setRowValue(next, "spending", i, "monthly", 500);
  next = setRowValue(next, "spending", i, "fromYear", parseNumField("")); // "" → null
  next = setRowValue(next, "spending", i, "growthPct", parseNumField("")); // "" → null = with inflation
  const row = next.spending[i];
  assert.equal(row.fromYear, null, "empty from-year stays null (not 0)");
  assert.equal(row.growthPct, null, "blank increase means 'with inflation', stored as null");
  assert.deepEqual(validate(next).errors, [], "row validates");
});

// ---------------------------------------------------------------------------
// formatting
// ---------------------------------------------------------------------------

test("fmtMoney: commas, true minus for negatives, em dash for null", () => {
  assert.equal(fmtMoney(1_234_567), "$1,234,567");
  assert.equal(fmtMoney(-1234), "−$1,234");
  assert.equal(fmtMoney(0), "$0");
  assert.equal(fmtMoney(null), "—");
});

test("fmtCompact: millions/thousands with trailing zeros stripped", () => {
  assert.equal(fmtCompact(2_000_000), "$2M");
  assert.equal(fmtCompact(1_500_000), "$1.5M");
  assert.equal(fmtCompact(1_250_000), "$1.25M");
  assert.equal(fmtCompact(-2_500_000), "−$2.5M");
  assert.equal(fmtCompact(85_500), "$86K");
  assert.equal(fmtCompact(500), "$500");
});

test("yearDelta: year plus years-from-now, singular/plural", () => {
  assert.equal(yearDelta(2043, 2026), "2043 (17 yrs)");
  assert.equal(yearDelta(2027, 2026), "2027 (1 yr)");
});

// ---- v6: accounts, buckets, taxes (pure transforms behind the inputs) ----

test("account rows: add, change type, blank contributions read as $0", () => {
  const s = placeholderState();
  let next = addRow(s, "accounts");
  const i = next.accounts.length - 1;
  assert.equal(next.accounts[i].type, "taxable", "a new account starts as taxable");
  assert.equal(next.accounts[i].invest, "buckets", "and in the three-bucket plan");
  next = setRowValue(next, "accounts", i, "type", parseRowField("accounts", "type", "roth_ira", true));
  next = setRowValue(next, "accounts", i, "contributionAnnual", parseRowField("accounts", "contributionAnnual", "", false));
  next = setRowValue(next, "accounts", i, "costBasis", parseRowField("accounts", "costBasis", "", false));
  next = setRowValue(next, "accounts", i, "contributeYears", parseRowField("accounts", "contributeYears", "", false));
  next = setRowValue(next, "accounts", i, "invest", parseRowField("accounts", "invest", "income", true));
  assert.equal(next.accounts[i].type, "roth_ira");
  assert.equal(next.accounts[i].contributionAnnual, 0, "a cleared contribution is $0, not an error");
  assert.equal(next.accounts[i].costBasis, null, "a cleared cost basis means 'same as balance'");
  assert.equal(next.accounts[i].contributeYears, 0, "cleared years is 0, not an error");
  assert.equal(next.accounts[i].invest, "income");
  assert.deepEqual(validate(next).errors, []);
  assert.equal(s.accounts.length, placeholderState().accounts.length, "input never mutated");
});

test("switching a bucket-plan account to traditional IRA moves it to high income; an explicit choice is kept", () => {
  const s = placeholderState();
  let next = addRow(s, "accounts");
  const i = next.accounts.length - 1;
  next = setRowValue(next, "accounts", i, "type", "traditional_ira");
  assert.equal(next.accounts[i].invest, "income");
  next = setRowValue(next, "accounts", i, "invest", "equities");
  next = setRowValue(next, "accounts", i, "type", "401k");
  next = setRowValue(next, "accounts", i, "type", "traditional_ira");
  assert.equal(next.accounts[i].invest, "equities", "a choice you made isn't overridden");
});

test("gainShareOf: taxable only; blank basis means no gain", () => {
  assert.equal(gainShareOf({ type: "taxable", balance: 100_000, costBasis: 60_000 }), 0.4);
  assert.equal(gainShareOf({ type: "taxable", balance: 100_000, costBasis: null }), 0);
  assert.equal(gainShareOf({ type: "taxable", balance: 100_000, costBasis: 120_000 }), 0, "a loss is 0% gain, never negative");
  assert.equal(gainShareOf({ type: "roth_ira", balance: 100_000, costBasis: null }), null);
});

test("bucket and tax inputs write through and keep the state valid", () => {
  let s = placeholderState();
  s = setValueAtPath(s, "economy.inflationPct", parseNumField("3"));
  s = setValueAtPath(s, "buckets.preservationYears", parseNumField("5"));
  s = setValueAtPath(s, "buckets.incomeThroughYear", parseNumField("12"));
  s = setValueAtPath(s, "taxes.ordinaryIncomePct", parseNumField("24"));
  assert.equal(s.economy.inflationPct, 3);
  assert.equal(s.buckets.preservationYears, 5);
  assert.deepEqual(validate(s).errors, []);
  const bad = setValueAtPath(s, "buckets.incomeThroughYear", 3);
  assert.ok(validate(bad).errors.some((e) => e.path === "buckets.incomeThroughYear"), "high income can't end before capital preservation");
});
