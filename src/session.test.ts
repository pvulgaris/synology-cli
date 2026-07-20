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
  readSession,
  withSessionLock,
  writeSession,
} from "./session.js";

function tmpPath(name = "session.json"): string {
  return join(mkdtempSync(join(tmpdir(), "syno-session-")), name);
}

// ── Persistence ─────────────────────────────────────────────────────────────

test("session: round-trips a record", () => {
  const p = tmpPath();
  writeSession(p, { sid: "abc", at: 1000, totpWindow: 42 });
  assert.deepEqual(readSession(p), { sid: "abc", at: 1000, totpWindow: 42 });
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
  writeSession(p, { sid: "abc", at: 1, totpWindow: 1 });
  assert.equal(statSync(p).mode & 0o777, 0o600);
});

test("session: no temp file survives a write", () => {
  const p = tmpPath();
  writeSession(p, { sid: "abc", at: 1, totpWindow: 1 });
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
