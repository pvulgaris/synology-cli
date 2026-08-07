import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "../dist/cli.js");

test("build: generated CLI entry point works", () => {
  if (process.platform !== "win32") {
    assert.equal(statSync(CLI).mode & 0o111, 0o111);
  }

  const result = spawnSync(process.execPath, [CLI, "--help"], {
    encoding: "utf8",
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^syno /);
});
