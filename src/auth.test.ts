/**
 * Credential resolution — the `<NAME>_FILE` (Docker *_FILE convention) vs direct
 * env precedence, and fail-closed behavior. The server reads secrets only from
 * env / *_FILE (no built-in secret manager), so these need no external binary.
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCredentials, loadDsmOnlyCredentials } from "./auth.js";

// Temp dirs created by tmpSecret, cleaned after each test (one top-level hook so
// the last test's dir is cleaned too — registering afterEach from inside a test
// would miss it).
const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

/** Apply `env` over process.env for the duration of async `fn`, then restore. */
async function withEnv(
  env: Record<string, string | undefined>,
  fn: () => Promise<void>
): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) saved[k] = process.env[k];
  try {
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** Write `contents` to a fresh temp file and return its path; auto-cleaned. */
function tmpSecret(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "auth-test-"));
  const path = join(dir, "secret");
  writeFileSync(path, contents, { mode: 0o600 });
  tmpDirs.push(dir);
  return path;
}

// Clear the env vars these tests toggle so an ambient DSM_* in the shell (dev
// source-creds) can't leak in and flip a result.
const CLEAR = {
  DSM_PASSWORD: undefined,
  DSM_PASSWORD_FILE: undefined,
  DSM_TOTP_SECRET: undefined,
  DSM_TOTP_SECRET_FILE: undefined,
};

test("*_FILE sources the secret from the file, trimming the trailing newline", async () => {
  const pwFile = tmpSecret("s3cret-pw\n"); // echo writes a trailing \n
  const totpFile = tmpSecret("JBSWY3DPEHPK3PXP\n");
  await withEnv(
    { ...CLEAR, DSM_PASSWORD_FILE: pwFile, DSM_TOTP_SECRET_FILE: totpFile },
    async () => {
      const c = await loadDsmOnlyCredentials("DSM");
      assert.equal(c.password, "s3cret-pw");
      assert.equal(c.totpSecret, "JBSWY3DPEHPK3PXP");
    }
  );
});

test("direct env is used when no *_FILE is set", async () => {
  await withEnv(
    { ...CLEAR, DSM_PASSWORD: "envpw", DSM_TOTP_SECRET: "ENVTOTP" },
    async () => {
      const c = await loadDsmOnlyCredentials("DSM");
      assert.equal(c.password, "envpw");
      assert.equal(c.totpSecret, "ENVTOTP");
    }
  );
});

test("setting both NAME and NAME_FILE is refused (fail closed on ambiguity)", async () => {
  const pwFile = tmpSecret("filepw");
  await withEnv(
    {
      ...CLEAR,
      DSM_PASSWORD: "envpw",
      DSM_PASSWORD_FILE: pwFile,
      DSM_TOTP_SECRET: "ENVTOTP",
    },
    async () => {
      await assert.rejects(
        () => loadDsmOnlyCredentials("DSM"),
        /Both DSM_PASSWORD and DSM_PASSWORD_FILE are set/
      );
    }
  );
});

test("*_FILE unreadable fails closed naming the var + errno, WITHOUT leaking the path/value", async () => {
  // The path is deliberately a stand-in for the leak case: if an operator puts the
  // secret itself where a path goes, the error must NOT echo it into logs.
  await withEnv(
    {
      ...CLEAR,
      DSM_PASSWORD_FILE: "/nonexistent/path/pw",
      DSM_TOTP_SECRET: "ENVTOTP",
    },
    async () => {
      await assert.rejects(
        () => loadDsmOnlyCredentials("DSM"),
        (e: unknown) =>
          e instanceof Error &&
          /DSM_PASSWORD_FILE could not be read \(ENOENT\)/.test(e.message) &&
          !e.message.includes("/nonexistent/path/pw")
      );
    }
  );
});

test("the envPrefix keys the *_FILE lookup (SRM_* for the router)", async () => {
  const pwFile = tmpSecret("router-pw\n");
  await withEnv(
    { SRM_PASSWORD: undefined, SRM_PASSWORD_FILE: pwFile, SRM_TOTP_SECRET: "SRMTOTP", SRM_TOTP_SECRET_FILE: undefined },
    async () => {
      const c = await loadDsmOnlyCredentials("SRM");
      assert.equal(c.password, "router-pw");
      assert.equal(c.totpSecret, "SRMTOTP");
    }
  );
});


test("an empty (truncated) secret file fails closed", async () => {
  // A `> file` interrupted mid-write leaves "". secretFromEnv trims to "" (falsy),
  // so this must reject via assertDsmCreds, never silently boot with a blank secret.
  const emptyPw = tmpSecret("   \n"); // whitespace-only → "" after trim
  await withEnv(
    { ...CLEAR, DSM_PASSWORD_FILE: emptyPw, DSM_TOTP_SECRET: "ENVTOTP" },
    async () => {
      await assert.rejects(() => loadDsmOnlyCredentials("DSM"), /DSM password is empty/);
    }
  );
});

test('an empty-string env var (compose ${VAR:-}) is treated as absent, so *_FILE wins', async () => {
  // Container Manager injects "" (not unset) for an unset host var. secretFromEnv's
  // truthiness must treat "" as absent: no both-set throw, and the file is used.
  const pwFile = tmpSecret("filepw\n");
  await withEnv(
    { ...CLEAR, DSM_PASSWORD: "", DSM_PASSWORD_FILE: pwFile, DSM_TOTP_SECRET: "ENVTOTP" },
    async () => {
      const c = await loadDsmOnlyCredentials("DSM");
      assert.equal(c.password, "filepw");
    }
  );
});

test("a HALF-set pair throws 'set together' (not a silent fall-through to another identity)", async () => {
  // Password (file) set, totp absent — credsFromPrefix must reject the half-set pair
  // rather than let it fall through and mix a partial override with another source.
  const pwFile = tmpSecret("pw\n");
  await withEnv(
    { ...CLEAR, DSM_PASSWORD_FILE: pwFile /* totp absent */ },
    async () => {
      await assert.rejects(
        () => loadDsmOnlyCredentials("DSM"),
        /DSM_PASSWORD and DSM_TOTP_SECRET must be set together/
      );
    }
  );
});

test("BOTH secrets absent fails closed via assertDsmCreds (distinct from half-set)", async () => {
  await withEnv({ ...CLEAR /* nothing set */ }, async () => {
    await assert.rejects(
      () => loadDsmOnlyCredentials("DSM"),
      /DSM password is empty — set DSM_PASSWORD or DSM_PASSWORD_FILE/
    );
  });
});



test("*_FILE that is a symlink is refused (not followed)", async () => {
  const real = tmpSecret("realpw\n");
  const link = join(real.slice(0, real.lastIndexOf("/")), "linkpw");
  symlinkSync(real, link);
  await withEnv(
    { ...CLEAR, DSM_PASSWORD_FILE: link, DSM_TOTP_SECRET: "ENVTOTP" },
    async () => {
      await assert.rejects(() => loadDsmOnlyCredentials("DSM"), /DSM_PASSWORD_FILE is a symlink/);
    }
  );
});

