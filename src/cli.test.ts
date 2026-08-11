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
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "cli.ts");
const VERIFY = join(
  dirname(fileURLToPath(import.meta.url)),
  "dev",
  "verify-tools.ts"
);

function run(args: string[]): { code: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, ["--import", "tsx", CLI, ...args], {
    encoding: "utf8",
    // A dummy base URL so target loading succeeds; every case here throws (or returns)
    // during argument handling, before any DSM call, so it's never dialed.
    env: { ...process.env, DSM_BASE_URL: "https://localhost:1", DSM_PASSWORD: "x", DSM_TOTP_SECRET: "x" },
  });
  return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

function runAsync(
  args: string[],
  env: NodeJS.ProcessEnv
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", CLI, ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

test("exit: help is 0 and prints the full help to stdout", () => {
  const r = run(["help"]);
  assert.equal(r.code, 0);
  // The last help line must be present — proof stdout wasn't truncated on exit.
  assert.match(r.stdout, /Use `raw` for any endpoint/);
  assert.match(r.stdout, /--verbose/);
});

test("exit: --version is 0", () => {
  assert.equal(run(["--version"]).code, 0);
});

test("help --json exposes the machine-readable command manifest", () => {
  const r = run(["help", "--json"]);
  assert.equal(r.code, 0);
  const help = JSON.parse(r.stdout);
  const raw = help.commands.find((command: { name: string }) => command.name === "raw");
  assert.deepEqual(raw.platforms, ["dsm", "srm"]);
  assert.deepEqual(raw.flags["params-json"], {
    type: "string",
    required: false,
    value: "JSON",
  });
  assert.equal(raw.flags.target.value, "dsm|srm");
  assert.equal(raw.flags.verbose.type, "boolean");
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

test("exit: unknown flags and extra arguments are rejected", () => {
  assert.equal(run(["status", "--typo=1"]).code, 2);
  assert.equal(run(["status", "extra"]).code, 2);
});

test("exit: a write without --yes is 2 (refused, not attempted)", () => {
  const r = run(["packages", "uninstall", "Foo"]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--yes/);
});

test("exit: a raw GET-transport mutation without --yes is refused", () => {
  const r = run(["raw", "SYNO.Docker.Image", "delete", "name=app"]);
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

test("verify: an unscoped run selects only the configured target's commands", () => {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("DSM_") || key.startsWith("SRM_")) delete env[key];
  }
  // Unreachable on purpose: selection is what's under test, so each command is
  // expected to print its header and then fail to connect.
  env.SRM_BASE_URL = "https://127.0.0.1:9";
  env.SRM_PASSWORD = "x";
  env.SRM_TOTP_SECRET = "JBSWY3DPEHPK3PXP";
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", VERIFY],
    { encoding: "utf8", env }
  );
  assert.match(result.stderr, /=== router update-check ===/);
  assert.doesNotMatch(result.stderr, /=== status ===|=== packages list ===/);
});

test("SRM-only commands authenticate and run without DSM configuration", async () => {
  const requests: URL[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    requests.push(url);
    response.setHeader("content-type", "application/json");
    if (url.pathname.endsWith("/auth.cgi")) {
      response.end(JSON.stringify({ success: true, data: { sid: "test-sid" } }));
    } else if (url.searchParams.get("api") === "SYNO.Core.System") {
      response.end(JSON.stringify({ success: true, data: { firmware_ver: "SRM test" } }));
    } else {
      response.end(JSON.stringify({ success: true, data: { available: false } }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith("DSM_")) delete env[key];
    Object.assign(env, {
      SRM_BASE_URL: `http://127.0.0.1:${address.port}`,
      SRM_USER: "agent",
      SRM_PASSWORD: "password",
      SRM_TOTP_SECRET: "JBSWY3DPEHPK3PXP",
      SRM_SID_CACHE_FILE: join(mkdtempSync(join(tmpdir(), "syno-srm-cli-")), "session.json"),
    });
    const result = await runAsync(["router", "update-check", "--verbose"], env);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).current_version, "SRM test");
    assert.match(result.stderr, /\[syno:srm\] → GET SYNO\.Core\.System\.info/);
    const login = requests.find((request) => request.pathname.endsWith("auth.cgi"));
    assert.equal(login?.searchParams.get("version"), "3");
    assert.equal(requests.some((request) => request.pathname.endsWith("entry.cgi")), true);
    const raw = await runAsync(
      ["raw", "SYNO.Core.System", "info", "--target=srm"],
      env
    );
    assert.equal(raw.code, 0, raw.stderr);
    assert.equal(JSON.parse(raw.stdout).firmware_ver, "SRM test");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve()))
    );
  }
});
