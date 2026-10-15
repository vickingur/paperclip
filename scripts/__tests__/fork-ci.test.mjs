import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { verify } from "../fork-ci.mjs";
const lanes = JSON.parse(readFileSync("scripts/fork-ci-lanes.json", "utf8"));
test("complete manifest covers every stable suite and workspace slice", () => {
  assert.equal(verify().length, 25);
});
test("omitted and duplicated lanes fail closed", () => {
  assert.throws(() => verify(lanes.slice(1)));
  assert.throws(() => verify([...lanes, lanes[0]]));
});
test("duplicate slice under a valid lane ID fails coverage", () => {
  const changed = structuredClone(lanes);
  changed[1].args = changed[0].args;
  assert.throws(() => verify(changed));
});
