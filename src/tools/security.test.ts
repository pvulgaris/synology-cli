/**
 * Tests for the account active/disabled determination. This used to live in the
 * skill as prose the model applied at audit time (parse `expired`, compare a date
 * to today). It's now computed here so the audit doesn't depend on that, and this
 * pins the classification so a regression fails a test rather than silently
 * dropping (or inventing) a finding.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { userActive } from "./security.js";

test("userActive: 'normal' is active", () => {
  assert.deepEqual(userActive("normal"), { active: true, indeterminate: false });
});

test("userActive: 'now' is disabled (how DSM encodes a disabled account)", () => {
  assert.deepEqual(userActive("now"), { active: false, indeterminate: false });
});

test("userActive: a date value is NOT guessed — it flags indeterminate (active)", () => {
  // We don't parse dates: the format is unconfirmed and the boundary is
  // timezone-dependent. A scheduled-expiry account is flagged for a human, and
  // stays active so its findings aren't suppressed.
  for (const v of ["2027-01-01", "2020-01-01", "2026-07-21"]) {
    assert.deepEqual(userActive(v), { active: true, indeterminate: true }, v);
  }
});

test("userActive: leniently-parseable non-dates don't sneak through as disabled", () => {
  // Date.parse would read these as past dates and mark the account disabled;
  // that suppression is exactly what this fix prevents.
  for (const v of ["0", "1", "2026", "12", "2026-13-01"]) {
    assert.deepEqual(userActive(v), { active: true, indeterminate: true }, v);
  }
});

test("userActive: a non-string value is indeterminate, not a crash", () => {
  assert.deepEqual(userActive(undefined), { active: true, indeterminate: true });
  assert.deepEqual(userActive(0), { active: true, indeterminate: true });
});
