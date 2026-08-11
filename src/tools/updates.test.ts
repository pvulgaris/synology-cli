/**
 * Unit coverage for the OS-update mapper — the response shapes a live NAS or
 * router can't be made to produce on demand (you can't manufacture a pending
 * update, and DSM and SRM disagree on where the result nests).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mapOsUpdate } from "../types.js";

test("mapOsUpdate: DSM nests the result under `update`", () => {
  const o = mapOsUpdate(
    { update: { available: true, version: "DSM 7.2.2-72806 Update 1", reboot: true } },
    "DSM 7.2.1-69057 Update 5"
  );
  assert.equal(o.available, true);
  assert.equal(o.available_version, "DSM 7.2.2-72806 Update 1");
  assert.equal(o.current_version, "DSM 7.2.1-69057 Update 5");
  assert.equal(o.reboot_required, true);
});

test("mapOsUpdate: SRM returns the same flat {available,version} shape (live-confirmed)", () => {
  // Verified against SRM 1.3.1 on 2026-06-26 — the anticipated {type,version}-only
  // shape never materialised; SRM reuses DSM's flat shape, so no special-casing.
  const o = mapOsUpdate(
    { available: true, version: "SRM 1.3.2-9366" },
    "SRM 1.3.1-9346 Update 13"
  );
  assert.equal(o.available, true);
  assert.equal(o.available_version, "SRM 1.3.2-9366");
  assert.equal(o.current_version, "SRM 1.3.1-9346 Update 13");
});

test("mapOsUpdate: available flag but no named version ⇒ not available (silence guard)", () => {
  // The "checking…"/transient case. Biasing to silence avoids crying wolf.
  const o = mapOsUpdate({ available: true }, "DSM 7.2.2-72806");
  assert.equal(o.available, false);
  assert.equal(o.available_version, null);
  // ...but the parse-miss is surfaced — this warning is the standing-in observability
  // for a live HAR: an availability flag with no version means a shape change.
  assert.match(o.warning ?? "", /no version parsed/);
});

test("mapOsUpdate: not-available response ⇒ false, null version", () => {
  const o = mapOsUpdate({ available: false, version: "" }, "DSM 7.2.2-72806");
  assert.equal(o.available, false);
  assert.equal(o.available_version, null);
  assert.equal(o.warning, undefined); // genuinely up to date — no anomaly to flag
});

test("mapOsUpdate: null/empty check degrades, keeps current from the arg", () => {
  for (const check of [null, undefined, {}]) {
    const o = mapOsUpdate(check, "SRM 1.3.1-9346 Update 13");
    assert.equal(o.available, false);
    assert.equal(o.available_version, null);
    assert.equal(o.current_version, "SRM 1.3.1-9346 Update 13");
  }
});

test("mapOsUpdate: falls back to check.current.version and parses changelog url", () => {
  const o = mapOsUpdate(
    { update: { available: true, version: "x-1", url: "https://example.test/notes" }, current: { version: "x-0" } },
    null
  );
  assert.equal(o.current_version, "x-0");
  assert.equal(o.changelog_url, "https://example.test/notes");
  assert.equal(o.reboot_required, null); // neither reboot nor restart present
});

test("mapOsUpdate: accepts numeric-truthy available when a version is named", () => {
  // Some SYNO endpoints encode booleans as 1/0; with a concrete version the
  // silence guard must not reject a real update.
  const o = mapOsUpdate({ available: 1, version: "DSM 7.3-99999" }, "DSM 7.2.2-72806");
  assert.equal(o.available, true);
  assert.equal(o.available_version, "DSM 7.3-99999");
});

test("mapOsUpdate: stringy reboot 'false' is false, not Boolean('false')===true", () => {
  const o = mapOsUpdate(
    { update: { available: true, version: "v-2", reboot: "false" } },
    "v-1"
  );
  assert.equal(o.reboot_required, false);
});

