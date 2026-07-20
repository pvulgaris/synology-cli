/**
 * Command-surface tests: argv parsing, command resolution, and the write gate.
 *
 * The write gate is the one that matters most. Under MCP the client prompted
 * before invoking a write tool; here nothing does, so if `requiresConfirmation`
 * silently stops covering a command, an agent can uninstall a package with no
 * confirmation and nothing surfaces the regression.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  COMMANDS,
  parseArgv,
  requiresConfirmation,
  resolveCommand,
  type Command,
} from "./commands.js";

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

test("gate: raw is free on GET but gated on --post", () => {
  const raw = byName("raw");
  assert.equal(requiresConfirmation(raw, {}), false);
  assert.equal(requiresConfirmation(raw, { post: true }), true);
});

test("gate: every command that can mutate DSM is either mutating or raw", () => {
  // Encodes the rule the registry must keep: a command reaching a DSM write has
  // to be declared mutating. `raw` is the sanctioned exception, gated by --post.
  const writeish = COMMANDS.filter((c) =>
    /install|uninstall|update |control/.test(`${c.name} `)
  );
  for (const c of writeish) {
    if (c.name.startsWith("dsm update-check") || c.name === "updates") continue;
    assert.equal(c.mutating, true, `${c.name} touches state but is not marked mutating`);
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
