/**
 * Command-surface tests: argv parsing, command resolution, and the write gate.
 *
 * The write gate is the one that matters most. The CLI does not prompt, so if
 * `requiresConfirmation` stops covering a command, an agent can uninstall a
 * package with no confirmation.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  COMMANDS,
  UsageError,
  parseArgv,
  requiresConfirmation,
  resolveCommand,
  selectPlatform,
  validateInvocation,
  type Command,
  type CommandContext,
} from "./commands.js";
import { methodMayMutate } from "./client.js";

const cmd = (name: string): Command => {
  const c = COMMANDS.find((x) => x.name === name);
  assert.ok(c, `no such command: ${name}`);
  return c;
};

/** A CommandContext with a stub client and a throwaway audit dir. */
function ctx(over: Partial<CommandContext> & { auditDir?: string }): CommandContext {
  const auditLogDir = over.auditDir ?? mkdtempSync(join(tmpdir(), "syno-audit-"));
  return {
    runtime: { auditLogDir, tlsSkipVerify: false },
    target:
      over.target ??
      ({ platform: "dsm", baseUrl: "https://nas.test", user: "agent" } as any),
    client: over.client ?? ({ call: async () => ({ ok: true }) } as any),
    args: over.args ?? [],
    flags: over.flags ?? {},
  };
}

function auditLines(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .flatMap((f) => readFileSync(join(dir, f), "utf8").trim().split("\n"))
    .filter(Boolean);
}

// ── argv parsing ────────────────────────────────────────────────────────────

test("argv: separates positionals from flags", () => {
  const { argv, flags } = parseArgv(["packages", "info", "HyperBackup"]);
  assert.deepEqual(argv, ["packages", "info", "HyperBackup"]);
  assert.deepEqual(flags, {});
});

test("argv: bare flag is true, --k=v carries its value", () => {
  const { flags } = parseArgv(["packages", "install", "Foo", "--yes", "--version=1.2.3"]);
  assert.equal(flags.yes, true);
  assert.equal(flags.version, "1.2.3");
});

test("argv: a flag value may itself contain '='", () => {
  // Real case: raw params are JSON, e.g. --extra={"a":"b=c"}
  const { flags } = parseArgv(['--extra={"a":"b=c"}']);
  assert.equal(flags.extra, '{"a":"b=c"}');
});

test("argv: `--` stops flag parsing so raw can pass a literal --version param", () => {
  const { argv, flags } = parseArgv([
    "raw",
    "SYNO.Core.Share",
    "list",
    "--version=2",
    "--",
    "--version=9",
  ]);
  // Before `--` it sets the API version; after `--` it is just a positional.
  assert.equal(flags.version, "2");
  assert.deepEqual(argv, ["raw", "SYNO.Core.Share", "list", "--version=9"]);
});

// ── resolution ──────────────────────────────────────────────────────────────

test("resolve: matches a two-word command and returns the leftovers", () => {
  const r = resolveCommand(["packages", "info", "HyperBackup"]);
  assert.equal(r?.command.name, "packages info");
  assert.deepEqual(r?.args, ["HyperBackup"]);
});

test("resolve: longest container command path wins", () => {
  const r = resolveCommand(["containers", "projects", "deploy", "ha"]);
  assert.equal(r?.command.name, "containers projects deploy");
  assert.deepEqual(r?.args, ["ha"]);
});

test("resolve: matches a one-word command", () => {
  assert.equal(resolveCommand(["status"])?.command.name, "status");
});

test("resolve: longest path wins over a shorter prefix", () => {
  // "dsm update-check" must not be shadowed by "updates" or a bare "dsm".
  assert.equal(
    resolveCommand(["dsm", "update-check"])?.command.name,
    "dsm update-check"
  );
});

test("resolve: unknown command is null, not a throw", () => {
  assert.equal(resolveCommand(["nope"]), null);
  assert.equal(resolveCommand([]), null);
});

test("resolve: raw keeps its api/method plus trailing params as positionals", () => {
  const r = resolveCommand(["raw", "SYNO.Core.Share", "list", "shareType=all"]);
  assert.equal(r?.command.name, "raw");
  assert.deepEqual(r?.args, ["SYNO.Core.Share", "list", "shareType=all"]);
});

// ── write gate ──────────────────────────────────────────────────────────────

const byName = (name: string): Command => {
  const c = COMMANDS.find((x) => x.name === name);
  assert.ok(c, `no such command: ${name}`);
  return c;
};

test("gate: every mutating command requires confirmation", () => {
  const mutating = COMMANDS.filter((c) => c.mutating);
  // Guards against the registry losing its write commands and the test passing vacuously.
  assert.ok(mutating.length >= 4, "expected the package write commands to be present");
  for (const c of mutating) {
    assert.equal(requiresConfirmation(c, {}), true, `${c.name} is ungated`);
  }
});

test("gate: read commands are free to invoke", () => {
  for (const c of COMMANDS.filter((x) => !x.mutating && x.name !== "raw")) {
    assert.equal(requiresConfirmation(c, {}), false, `${c.name} should not be gated`);
  }
});

test("gate: raw read methods are free but POST is gated", () => {
  const raw = byName("raw");
  assert.equal(requiresConfirmation(raw, {}, ["SYNO.Core.Share", "list"]), false);
  assert.equal(requiresConfirmation(raw, {}, ["SYNO.Docker.Container", "stats"]), false);
  assert.equal(requiresConfirmation(raw, { post: true }), true);
});

test("gate: the snapshot, immutable-window and NFS rule getters are reads", () => {
  const raw = byName("raw");
  for (const [api, method] of [
    ["SYNO.Core.Share.Snapshot", "get_schedule"],
    ["SYNO.DisasterRecovery.Retention", "get_worm_lock"],
    ["SYNO.Core.FileServ.NFS.SharePrivilege", "load"],
  ]) {
    assert.equal(requiresConfirmation(raw, {}, [api, method]), false);
  }
  // The setters on the same APIs stay gated.
  assert.equal(requiresConfirmation(raw, { post: true }, ["SYNO.Core.Share.Snapshot", "set_schedule"]), true);
  assert.equal(requiresConfirmation(raw, {}, ["SYNO.DisasterRecovery.Retention", "set_worm_lock"]), true);
});

test("gate: known read-only VMM discovery calls do not require confirmation", () => {
  const raw = byName("raw");
  for (const method of ["list_resource", "check_availability", "gen_mac"]) {
    assert.equal(
      requiresConfirmation(raw, {}, ["SYNO.Virtualization.Guest", method]),
      false,
      method
    );
  }
  assert.equal(
    requiresConfirmation(
      raw,
      { post: true },
      ["SYNO.Virtualization.Guest", "read_ovf"]
    ),
    false
  );
  assert.equal(
    requiresConfirmation(raw, {}, ["SYNO.Other.Api", "gen_mac"]),
    true,
    "the exception must remain scoped to the observed VMM API"
  );
  assert.equal(
    requiresConfirmation(
      raw,
      {},
      ["SYNO.Virtualization.Cluster", "get_total_progress"]
    ),
    false
  );
  assert.equal(
    requiresConfirmation(raw, {}, ["SYNO.Other.Api", "get_total_progress"]),
    true,
    "the progress exception must remain scoped to the observed VMM API"
  );
});

test("gate: raw mutating methods require confirmation even when DSM uses GET", () => {
  const raw = byName("raw");
  assert.equal(requiresConfirmation(raw, {}, ["SYNO.Docker.Image", "delete"]), true);
  assert.equal(requiresConfirmation(raw, {}, ["SYNO.Docker.Project", "build"]), true);
  assert.equal(methodMayMutate("get"), false);
  assert.equal(methodMayMutate("unknown_future_method"), true);
});

test("gate: every command that can mutate DSM is either mutating or raw", () => {
  // Encodes the rule the registry must keep: a command reaching a DSM write has
  // to be declared mutating. `raw` is the sanctioned exception, gated by POST
  // or by a method outside its read allowlist.
  const writeish = COMMANDS.filter((c) =>
    /install|uninstall|update |control|apply/.test(`${c.name} `)
  );
  for (const c of writeish) {
    if (c.name.startsWith("dsm update-check") || c.name === "updates") continue;
    assert.equal(c.mutating, true, `${c.name} touches state but is not marked mutating`);
  }
});

test("exit: state drift is 3, distinct from a failure's 1", () => {
  for (const name of ["state check", "state apply"]) {
    assert.equal(byName(name).exitCode?.({ ok: false }), 3);
    assert.equal(byName(name).exitCode?.({ ok: true }), 0);
  }
});

test("registry: no duplicate command names", () => {
  const names = COMMANDS.map((c) => c.name);
  assert.equal(new Set(names).size, names.length);
});

test("registry: every command has a summary for --help", () => {
  for (const c of COMMANDS) {
    assert.ok(c.summary.length > 0, `${c.name} has no summary`);
  }
});

test("validation: unknown flags and extra arguments are usage errors", () => {
  assert.throws(() => validateInvocation(cmd("status"), [], { typo: true }), isUsage);
  assert.throws(() => validateInvocation(cmd("status"), ["extra"], {}), isUsage);
  assert.throws(
    () => validateInvocation(cmd("containers projects deploy"), ["ha"], { yes: true }),
    isUsage
  );
});

test("validation: commands accept the global verbose flag", () => {
  assert.doesNotThrow(() =>
    validateInvocation(cmd("status"), [], { verbose: true })
  );
});

test("validation: raw API versions must be complete integers", () => {
  const raw = cmd("raw");
  assert.throws(
    () => validateInvocation(raw, ["SYNO.Core.System", "info"], { version: "3junk" }),
    isUsage
  );
});

test("target selection: single-platform commands infer their target", () => {
  assert.equal(selectPlatform(cmd("router update-check"), {}), "srm");
  assert.equal(selectPlatform(cmd("status"), {}), "dsm");
  assert.equal(selectPlatform(cmd("raw"), { target: "srm" }), "srm");
  assert.throws(() => selectPlatform(cmd("status"), { target: "srm" }), isUsage);
});

// ── usage errors ────────────────────────────────────────────────────────────

// `run` throws synchronously; the async wrapper turns that into a rejection the
// top-level catch in cli.ts sees as a UsageError → exit 2.
const isUsage = (e: unknown) => e instanceof UsageError;

test("usage: an invalid control action throws UsageError", async () => {
  await assert.rejects(
    async () => cmd("packages control").run(ctx({ args: ["Foo", "frobnicate"] })),
    isUsage
  );
});

test("usage: a malformed raw param throws UsageError", async () => {
  await assert.rejects(
    async () => cmd("raw").run(ctx({ args: ["SYNO.Foo", "get", "notkv"] })),
    isUsage
  );
});

// ── raw audit ───────────────────────────────────────────────────────────────

test("raw GET is a read and writes no audit record", async () => {
  const auditDir = mkdtempSync(join(tmpdir(), "syno-audit-"));
  await cmd("raw").run(ctx({ auditDir, args: ["SYNO.Core.System", "info"] }));
  await cmd("raw").run(
    ctx({ auditDir, args: ["SYNO.Docker.Container", "stats"] })
  );
  assert.deepEqual(auditLines(auditDir), []);
});

test("known read-only VMM POST writes no mutation audit record", async () => {
  const auditDir = mkdtempSync(join(tmpdir(), "syno-audit-"));
  await cmd("raw").run(
    ctx({
      auditDir,
      args: ["SYNO.Virtualization.Guest", "read_ovf"],
      flags: { post: true },
    })
  );
  assert.deepEqual(auditLines(auditDir), []);
});

test("raw --params-json encodes values for Synology's form parser", async () => {
  let sent: Record<string, string> | undefined;
  const client = {
    call: async (opts: { params: Record<string, string> }) => {
      sent = opts.params;
      return {};
    },
  } as any;
  await cmd("raw").run(
    ctx({
      client,
      args: ["SYNO.Core.Share", "get"],
      flags: { "params-json": '{"name":"docs","limit":5,"active":true}' },
    })
  );
  assert.deepEqual(sent, { name: '"docs"', limit: "5", active: "true" });
});

test("raw GET-transport delete is audited as a write", async () => {
  const auditDir = mkdtempSync(join(tmpdir(), "syno-audit-"));
  await cmd("raw").run(
    ctx({
      auditDir,
      args: ["SYNO.Docker.Image", "delete", "name=app", "tag=old"],
    })
  );
  const rec = JSON.parse(auditLines(auditDir)[0]);
  assert.equal(rec.tool, "raw:SYNO.Docker.Image.delete");
  assert.equal(rec.ok, true);
});

test("raw --post writes an audit record like a named write", async () => {
  const auditDir = mkdtempSync(join(tmpdir(), "syno-audit-"));
  await cmd("raw").run(
    ctx({
      auditDir,
      args: ["SYNO.Docker.Project", "stop", "id=x"],
      flags: { post: true },
    })
  );
  const lines = auditLines(auditDir);
  assert.equal(lines.length, 1, "one audit record for the raw POST");
  const rec = JSON.parse(lines[0]);
  assert.equal(rec.tool, "raw:SYNO.Docker.Project.stop");
  assert.equal(rec.ok, true);
});

test("raw --post returns its response but redacts it from the audit", async () => {
  const auditDir = mkdtempSync(join(tmpdir(), "syno-audit-"));
  const secret = "PASSWORD: do-not-audit";
  const client = {
    call: async (opts: { sensitiveResponse?: boolean }) => {
      assert.equal(opts.sensitiveResponse, true);
      return { result: { content: secret }, id: "x" };
    },
  } as any;
  const out = await cmd("raw").run(
    ctx({
      auditDir,
      client,
      args: ["SYNO.Docker.Project", "update", "id=x", `content=${secret}`],
      flags: { post: true },
    })
  );
  assert.deepEqual(out, { result: { content: secret }, id: "x" });
  const line = auditLines(auditDir)[0];
  assert.doesNotMatch(line, /do-not-audit/);
  const rec = JSON.parse(line);
  assert.equal(rec.after.result.content, "***");
});

test("raw --post never writes a secret param value to the audit log", async () => {
  const auditDir = mkdtempSync(join(tmpdir(), "syno-audit-"));
  await cmd("raw").run(
    ctx({
      auditDir,
      args: ["SYNO.API.Auth", "login", "account=x", "passwd=hunter2"],
      flags: { post: true },
    })
  );
  const line = auditLines(auditDir)[0];
  assert.doesNotMatch(line, /hunter2/, "the password must not appear in the audit record");
  const rec = JSON.parse(line);
  assert.equal(rec.args.params.passwd, "***");
  assert.equal(rec.args.params.account, "x"); // non-secret still recorded
});
