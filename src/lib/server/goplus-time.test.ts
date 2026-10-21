import { test } from "node:test";
import assert from "node:assert/strict";
import { goplusEndTimeMs } from "./goplus-time.ts";

// GoPlus real-world shape: a unix timestamp in seconds, as a string (not an ISO date).
// Example from GoPlus docs: an LP lock unlocking on 2025-03-08 is sent as "1741392000".
test("parses a GoPlus end_time (unix seconds string) into a millisecond timestamp", () => {
  const ms = goplusEndTimeMs("1741392000");
  assert.equal(ms, 1741392000 * 1000);
  assert.equal(new Date(ms!).toISOString().slice(0, 10), "2025-03-08");
});

test("returns undefined for an absent end_time", () => {
  assert.equal(goplusEndTimeMs(undefined), undefined);
  assert.equal(goplusEndTimeMs(""), undefined);
});

test("returns undefined for a non-numeric end_time instead of silently going NaN", () => {
  assert.equal(goplusEndTimeMs("not-a-date"), undefined);
});
