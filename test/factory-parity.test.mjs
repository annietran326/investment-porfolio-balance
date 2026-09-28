// forms.mjs (a browser+Node module) inlines its blank-row/person builders as
// literals because it cannot import the schema factories across the public->src
// boundary (see test/browser-imports.test.mjs). This test pins those literals
// equal to the schema factories in Node, so the two definitions can never drift
// — add a schema field and this fails until the UI blank is updated too.
import { test } from "node:test";
import assert from "node:assert/strict";
import { newIncome, newSpendingCategory, newPerson, newAccount } from "../src/model/schema.mjs";
import { blankRow, addPerson } from "../public/ui/forms.mjs";
import { defaultState } from "../src/model/schema.mjs";

const state = () => ({ ...defaultState(), profile: { currentAge: 40, endAge: 95, currentYear: 2026 } });

test("blankRow mirrors the schema factories", () => {
  assert.deepEqual(blankRow("accounts", state()), newAccount({ name: "new account" }));
  assert.deepEqual(blankRow("incomes", state()), newIncome({ name: "new income", fromYear: 2026, toYear: 2030 }));
  assert.deepEqual(blankRow("spending", state()), newSpendingCategory({ name: "new category" }));
});

test("addPerson mirrors the schema newPerson factory", () => {
  const withSpouse = addPerson(state(), "spouse");
  assert.deepEqual(withSpouse.household.people.at(-1), newPerson("spouse", { name: "Spouse" }));
  const withDep = addPerson(state(), "dependent");
  assert.deepEqual(withDep.household.people.at(-1), newPerson("dependent", { name: "Dependent" }));
});
