/**
 * Install-credential acquisition. The prompt path needs a TTY; here we cover the
 * env fast-path (DSM_PASSWORD / DSM_TOTP_SECRET) that non-interactive callers —
 * including `op run` — rely on, so no prompt is attempted when both are present.
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { gatherDsmCredentials, gatherInstallCredentials } from "./creds.js";

const saved = { pw: process.env.DSM_PASSWORD, totp: process.env.DSM_TOTP_SECRET };
afterEach(() => {
  process.env.DSM_PASSWORD = saved.pw;
  process.env.DSM_TOTP_SECRET = saved.totp;
});

test("gatherDsmCredentials uses env without prompting (direct env kept as-is, not trimmed)", async () => {
  // Now resolves via secretFromEnv, which deliberately does NOT trim direct env — a
  // password may legitimately carry edge spaces (only the *_FILE form trims a newline).
  process.env.DSM_PASSWORD = " pw with spaces ";
  process.env.DSM_TOTP_SECRET = "SEED32";
  const c = await gatherDsmCredentials();
  assert.deepEqual(c, { password: " pw with spaces ", totpSecret: "SEED32" });
});

test("gatherInstallCredentials adds a fresh 64-hex bearer", async () => {
  process.env.DSM_PASSWORD = "pw";
  process.env.DSM_TOTP_SECRET = "SEED32";
  const c = await gatherInstallCredentials();
  assert.equal(c.password, "pw");
  assert.match(c.bearer, /^[0-9a-f]{64}$/);
});
