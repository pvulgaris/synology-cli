/**
 * Pure-logic tests for the install/provision path. The network + DSM-API bits are
 * verified live; here we cover the release-asset integrity check that decides
 * whether a downloaded image tar is imported.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { sha256Matches } from "./provision.js";

const data = Buffer.from("synology-mcp image tar bytes");
const good = createHash("sha256").update(data).digest("hex");

test("accepts the matching sha256", () => {
  assert.equal(sha256Matches(good, data), true);
});

test("rejects a mismatched sha256 (tampered/truncated asset)", () => {
  assert.equal(sha256Matches(good, Buffer.concat([data, Buffer.from("!")])), false);
});

test("rejects a malformed checksum (e.g. a 404 page saved as .sha256)", () => {
  assert.equal(sha256Matches("not-a-hash", data), false);
  assert.equal(sha256Matches("", data), false);
  assert.equal(sha256Matches(good.toUpperCase(), data), false); // must be lowercase hex
});
