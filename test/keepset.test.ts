import assert from "node:assert/strict";
import { test } from "node:test";
import { keepCap } from "@hypercarrier/auto-compact-durable/keepset";

test("keepset caps retained output at one quarter of the working budget, up to 20k", () => {
  assert.equal(keepCap(8_000), 2_000);
  assert.equal(keepCap(400_000), 20_000);
  assert.equal(keepCap(undefined), 20_000);
});
