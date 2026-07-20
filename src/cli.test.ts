/**
 * End-to-end exit-code and output tests. These spawn the real entry point so the
 * `finish` flush path and the UsageError→exit-2 mapping are exercised as a user
 * (or an agent) actually hits them, not just as unit calls.
 *
 * Every case here returns before any DSM call, so no credentials or NAS are
 * needed — the process decides the exit code from argument parsing alone.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "cli.ts");

function run(args: string[]): { code: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, ["--import", "tsx", CLI, ...args], {
    encoding: "utf8",
    // A dummy base URL so loadConfig succeeds; every case here throws (or returns)
    // during argument handling, before any DSM call, so it's never dialed.
    env: { ...process.env, DSM_BASE_URL: "https://localhost:1", DSM_PASSWORD: "x", DSM_TOTP_SECRET: "x" },
  });
  return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

test("exit: help is 0 and prints the full help to stdout", () => {
  const r = run(["help"]);
  assert.equal(r.code, 0);
  // The last help line must be present — proof stdout wasn't truncated on exit.
  assert.match(r.stdout, /string params need JSON quotes/);
});

test("exit: --version is 0", () => {
  assert.equal(run(["--version"]).code, 0);
});

test("exit: an unknown command is 2", () => {
  assert.equal(run(["boguscmd"]).code, 2);
});

test("exit: a missing required argument is 2", () => {
  assert.equal(run(["packages", "info"]).code, 2);
});

test("exit: an invalid control action is 2", () => {
  assert.equal(run(["packages", "control", "Foo", "frobnicate", "--yes"]).code, 2);
});

test("exit: a malformed raw param is 2", () => {
  assert.equal(run(["raw", "SYNO.Foo", "get", "notkv"]).code, 2);
});

test("exit: a write without --yes is 2 (refused, not attempted)", () => {
  const r = run(["packages", "uninstall", "Foo"]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--yes/);
});

test("output: the result goes to stdout, diagnostics to stderr", () => {
  // help is the only NAS-free command that emits a payload; it must land on
  // stdout so `syno ... | jq` never has to filter stderr noise.
  const r = run(["help"]);
  assert.ok(r.stdout.length > 0);
  assert.equal(r.stderr, "");
});
