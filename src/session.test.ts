/**
 * Session-store tests.
 *
 * These cover the machinery that replaced the daemon's in-memory SID. The
 * failure modes are all concurrency-shaped and none of them announce themselves
 * — a broken lock just means an occasional DSM error 404 that looks like a bad
 * password — so they are pinned here rather than left to live testing.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  TOTP_WINDOW_MS,
  awaitFreshTotpWindow,
  currentTotpWindow,
  defaultSessionPath,
  readSession,
  sessionMatches,
  withSessionLock,
  writeSession,
} from "./session.js";
import { readFileSync } from "node:fs";

function tmpPath(name = "session.json"): string {
  return join(mkdtempSync(join(tmpdir(), "syno-session-")), name);
}

// ── Persistence ─────────────────────────────────────────────────────────────

const REC = {
  sid: "abc",
  at: 1000,
  totpWindow: 42,
  baseUrl: "https://nas.local:5001",
  user: "claude-mcp",
};

test("session: round-trips a record", () => {
  const p = tmpPath();
  writeSession(p, REC);
  assert.deepEqual(readSession(p), REC);
});

test("session: identity gates whether a record is usable", () => {
  const p = tmpPath();
  writeSession(p, REC);
  const back = readSession(p)!;
  assert.equal(sessionMatches(back, REC.baseUrl, REC.user), true);
  // A SID minted for a different account or NAS must never be adopted here.
  assert.equal(sessionMatches(back, REC.baseUrl, "someone-else"), false);
  assert.equal(sessionMatches(back, "https://other:5001", REC.user), false);
});

test("session: a pre-identity record fails match, forcing a fresh login", () => {
  const p = tmpPath();
  writeFileSync(p, JSON.stringify({ sid: "abc", at: 1000, totpWindow: 1 }));
  const back = readSession(p)!;
  assert.equal(sessionMatches(back, "https://nas.local:5001", "claude-mcp"), false);
});

test("session: default path differs per target+account", () => {
  const a = defaultSessionPath("syno-cli", "https://nas.local:5001", "claude-mcp");
  const b = defaultSessionPath("syno-cli", "https://nas.local:5001", "other");
  const c = defaultSessionPath("syno-cli", "https://other:5001", "claude-mcp");
  assert.notEqual(a, b);
  assert.notEqual(a, c);
});

test("session: missing file is a cache miss, not a throw", () => {
  assert.equal(readSession(tmpPath("absent.json")), null);
});

test("session: a truncated file is a cache miss, not a throw", () => {
  const p = tmpPath();
  writeFileSync(p, '{"sid":"abc","at":');
  assert.equal(readSession(p), null);
});

test("session: a record without a sid is rejected", () => {
  const p = tmpPath();
  writeFileSync(p, JSON.stringify({ at: 1000 }));
  assert.equal(readSession(p), null);
});

test("session: file is written 0600 — a SID is a bearer credential", () => {
  const p = tmpPath();
  writeSession(p, REC);
  assert.equal(statSync(p).mode & 0o777, 0o600);
});

test("session: no temp file survives a write", () => {
  const p = tmpPath();
  writeSession(p, REC);
  assert.equal(existsSync(`${p}.${process.pid}.tmp`), false);
});

// ── Locking ─────────────────────────────────────────────────────────────────

test("lock: concurrent holders never overlap", async () => {
  const p = tmpPath();
  const events: string[] = [];
  let inside = 0;

  const hold = (id: string) =>
    withSessionLock(p, async () => {
      inside += 1;
      // The property under test: never more than one holder at a time.
      assert.equal(inside, 1, `${id} entered while another holder was inside`);
      events.push(`enter:${id}`);
      await new Promise((r) => setTimeout(r, 20));
      events.push(`exit:${id}`);
      inside -= 1;
    });

  await Promise.all([hold("a"), hold("b"), hold("c")]);

  // Every enter is immediately followed by its own exit.
  for (let i = 0; i < events.length; i += 2) {
    assert.equal(events[i].split(":")[0], "enter");
    assert.equal(events[i + 1].split(":")[0], "exit");
    assert.equal(events[i].split(":")[1], events[i + 1].split(":")[1]);
  }
  assert.equal(events.length, 6);
});

test("lock: released when the body throws, or the next call deadlocks", async () => {
  const p = tmpPath();
  await assert.rejects(
    withSessionLock(p, async () => {
      throw new Error("boom");
    }),
    /boom/
  );
  // Would time out rather than resolve if the lock leaked.
  assert.equal(await withSessionLock(p, async () => "ok"), "ok");
});

test("lock: a stale lock is broken rather than waited on", async () => {
  const p = tmpPath();
  // A holder that died without releasing.
  writeFileSync(`${p}.lock`, "");
  const started = Date.now();
  const got = await withSessionLock(p, async () => "ok", {
    staleMs: 0,
    timeoutMs: 2000,
  });
  assert.equal(got, "ok");
  assert.ok(Date.now() - started < 500, "should break the stale lock promptly");
});

test("lock: a live lock times out instead of hanging forever", async () => {
  const p = tmpPath();
  writeFileSync(`${p}.lock`, "");
  await assert.rejects(
    withSessionLock(p, async () => "unreachable", {
      staleMs: 60_000,
      timeoutMs: 150,
    }),
    /Timed out .* waiting for the DSM session lock/
  );
});

test("lock: the lock file is cleaned up after a normal release", async () => {
  const p = tmpPath();
  await withSessionLock(p, async () => "ok");
  assert.equal(existsSync(`${p}.lock`), false);
});

test("lock: an overrun holder doesn't unlink a successor's lock", async () => {
  // The race the ownership token defends against: holder A overruns staleMs, B
  // breaks A's lock and takes its own, then A's cleanup runs. A must NOT unlink
  // B's lock, or a third process could enter alongside B.
  const p = tmpPath();
  let bTokenSeen: string | undefined;
  const a = withSessionLock(
    p,
    async () => {
      // Hold long enough that B (with staleMs:0) breaks and replaces our lock.
      await new Promise((r) => setTimeout(r, 120));
    },
    { staleMs: 100_000, timeoutMs: 5000 }
  );
  // Give A the lock first, then let B break it as stale.
  await new Promise((r) => setTimeout(r, 20));
  const b = withSessionLock(
    p,
    async () => {
      bTokenSeen = readFileSync(`${p}.lock`, "utf8");
      // Still holding when A's cleanup fires.
      await new Promise((r) => setTimeout(r, 120));
      return readFileSync(`${p}.lock`, "utf8");
    },
    { staleMs: 0, timeoutMs: 5000 }
  );
  await a;
  const bTokenAtExit = await b;
  // B's lock token survived A's cleanup unchanged.
  assert.equal(bTokenAtExit, bTokenSeen);
  assert.ok(bTokenSeen && bTokenSeen.length > 0);
});

test("lock: stale bound sits above the longest legitimate hold", async () => {
  // Regression guard for the Codex finding: the threshold must exceed a full
  // TOTP wait plus a login request, or a slow-but-healthy holder gets evicted.
  // The default staleMs is internal, so exercise it via the timeout arithmetic:
  // a live lock must still be waited on (not broken) for well past 60s worth.
  // Cheap proxy: a 120ms-old lock with the real default stale bound is NOT stale.
  const p = tmpPath();
  writeFileSync(`${p}.lock`, "someone-else");
  await assert.rejects(
    withSessionLock(p, async () => "unreachable", { timeoutMs: 150 }),
    /Timed out/,
    "a fresh foreign lock must be waited on under the default (>=90s) stale bound"
  );
});

// ── TOTP window ─────────────────────────────────────────────────────────────

test("totp: no previous login means no wait", async () => {
  assert.equal(await awaitFreshTotpWindow(undefined, { delay: shouldNotSleep }), 0);
});

test("totp: a login one window ago means no wait", async () => {
  const now = 1_000_000 * TOTP_WINDOW_MS;
  const waited = await awaitFreshTotpWindow(currentTotpWindow(now) - 1, {
    now: () => now,
    delay: shouldNotSleep,
  });
  assert.equal(waited, 0);
});

test("totp: reusing the current window waits out the remainder", async () => {
  // 10s into a 30s window ⇒ 20s left, plus the skew cushion.
  const windowStart = 1_000_000 * TOTP_WINDOW_MS;
  const now = windowStart + 10_000;
  let slept = -1;
  const waited = await awaitFreshTotpWindow(currentTotpWindow(now), {
    now: () => now,
    delay: async (ms) => {
      slept = ms;
    },
  });
  assert.equal(waited, 20_000 + 250);
  assert.equal(slept, 20_000 + 250);
});

test("totp: the wait always clears the boundary", async () => {
  // Property: from anywhere in a window, now + wait lands in the NEXT window.
  const windowStart = 1_000_000 * TOTP_WINDOW_MS;
  for (const offset of [0, 1, 7_777, 15_000, TOTP_WINDOW_MS - 1]) {
    const now = windowStart + offset;
    const waited = await awaitFreshTotpWindow(currentTotpWindow(now), {
      now: () => now,
      delay: async () => {},
    });
    assert.equal(
      currentTotpWindow(now + waited),
      currentTotpWindow(now) + 1,
      `offset ${offset} did not clear the window boundary`
    );
  }
});

async function shouldNotSleep(ms: number): Promise<void> {
  throw new Error(`expected no wait, but was asked to sleep ${ms}ms`);
}
