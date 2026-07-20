/**
 * Cross-process DSM session store.
 *
 * The daemon kept one SID in memory for its lifetime, so persisting it was a dev
 * convenience. A CLI is a fresh process per invocation, which turns two latent
 * problems into everyday ones:
 *
 *   1. Every invocation would log in. Beyond being slow (a login is a round-trip
 *      plus an `op`/file credential read), DSM rejects a second login reusing the
 *      same 30-second TOTP code with error 404. Two `syno` calls in one shell
 *      pipeline would fail the second one.
 *   2. Nothing coordinates concurrent invocations. `syno status & syno shares list &`
 *      both miss the cache, both log in, and DSM 404s whichever loses the race.
 *
 * So the SID cache is promoted from best-effort to load-bearing, and gets the two
 * things it was missing: an exclusive lock so only one process logs in at a time,
 * and a record of which TOTP window produced the SID so a genuinely-needed second
 * login waits for the next code rather than burning the current one.
 */

import {
  readFileSync,
  writeFileSync,
  writeSync,
  mkdirSync,
  openSync,
  closeSync,
  unlinkSync,
  renameSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";

/** TOTP step, in ms. RFC 6238's default and what DSM enforces. */
export const TOTP_WINDOW_MS = 30_000;

/** How long a cached SID is trusted. Matches the previous in-memory TTL. */
export const SID_TTL_MS = 10 * 60 * 1000;

/**
 * Longest a healthy holder can legitimately hold the lock: it may wait out a
 * full TOTP window (up to TOTP_WINDOW_MS) AND then make a login request that can
 * take up to the client's request timeout. The request timeout lives in dsm.ts;
 * duplicating its value here rather than importing keeps session.ts free of a
 * dependency on the client, at the cost of a comment that must track it (30s).
 */
const MAX_LOGIN_HOLD_MS = TOTP_WINDOW_MS + 30_000;

/**
 * How long before a lock is presumed abandoned and broken. Must sit safely above
 * MAX_LOGIN_HOLD_MS, or a slow-but-healthy holder gets its lock stolen mid-login
 * and two processes log in at once (the exact TOTP-reuse 404 the lock prevents).
 * The margin absorbs scheduling jitter. A truly dead holder does block others for
 * this long, but concurrent invocations are rare and the ownership check below is
 * the real safety net; the threshold only decides how long to wait first.
 */
const LOCK_STALE_MS = MAX_LOGIN_HOLD_MS + 30_000; // 90s

/** Poll interval while waiting for another process to release the lock. */
const LOCK_POLL_MS = 50;

/** Padding past the window boundary, so a slightly fast clock still lands clear. */
const TOTP_SKEW_CUSHION_MS = 250;

/** Injectable clock and sleep, so the TOTP wait is testable without waiting 30s. */
export interface TotpWaitDeps {
  now?: () => number;
  delay?: (ms: number) => Promise<unknown>;
}

export interface SessionRecord {
  sid: string;
  /** Epoch ms the SID was issued. Drives SID_TTL_MS expiry. */
  at: number;
  /** TOTP window index that produced this SID, so the next login can avoid reusing it. */
  totpWindow: number;
  /** The target+account this SID authenticates. A DSM SID is account-scoped, so a
   *  record whose identity doesn't match the current target must be ignored: adopting
   *  it would run commands (writes included) as the wrong account for up to the TTL. */
  baseUrl: string;
  user: string;
}

/** True when a cached record authenticates the target we're about to call. A
 *  record missing identity (an older on-disk format) never matches, which fails
 *  safe toward a fresh login. */
export function sessionMatches(
  rec: SessionRecord,
  baseUrl: string,
  user: string
): boolean {
  return rec.baseUrl === baseUrl && rec.user === user;
}

/** The TOTP window index a code generated now would belong to. */
export function currentTotpWindow(now = Date.now()): number {
  return Math.floor(now / TOTP_WINDOW_MS);
}

/**
 * Default session-file path for a target. Under XDG state (not cache): losing it
 * is harmless but it is not regenerable-on-demand free — a wiped file costs a
 * login and a TOTP window.
 */
export function stateDir(): string {
  const base =
    process.env.XDG_STATE_HOME?.trim() || join(homedir(), ".local", "state");
  return join(base, "syno");
}

/** Default session path, per target+account. The identity is folded into the
 *  filename (not just validated in the record) so two accounts on one NAS get
 *  separate files and don't invalidate each other's SIDs on every alternation.
 *  Record validation in readSession is the backstop for a hand-set shared path. */
export function defaultSessionPath(
  session: string,
  baseUrl: string,
  user: string
): string {
  const tag = createHash("sha256")
    .update(`${baseUrl}\n${user}`)
    .digest("hex")
    .slice(0, 8);
  return join(stateDir(), `session-${session}-${tag}.json`);
}

export function readSession(path: string): SessionRecord | null {
  try {
    const j = JSON.parse(readFileSync(path, "utf8"));
    if (typeof j?.sid === "string" && typeof j?.at === "number") {
      return {
        sid: j.sid,
        at: j.at,
        totpWindow: j.totpWindow ?? 0,
        baseUrl: typeof j.baseUrl === "string" ? j.baseUrl : "",
        user: typeof j.user === "string" ? j.user : "",
      };
    }
  } catch {
    // missing, unreadable, or truncated mid-write → cache miss
  }
  return null;
}

/**
 * Write via temp-file + rename so a reader never observes a half-written file.
 * The 0600 mode is set at open time rather than after: a SID is a bearer
 * credential for the whole DSM session, and a chmod-after-write leaves a window
 * where it is world-readable.
 */
export function writeSession(path: string, rec: SessionRecord): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(rec), { mode: 0o600 });
    renameSync(tmp, path);
  } catch {
    // Best-effort. A failed write costs a login next invocation, not correctness.
  }
}

export function clearSession(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // already gone
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Per-process counter so two locks acquired in the same millisecond by one
 *  process still get distinct ownership tokens. */
let lockSeq = 0;

/**
 * Hold an exclusive lock for `path` while `fn` runs.
 *
 * O_EXCL create is the lock: it is atomic on both local filesystems and, unlike
 * advisory locks, survives across unrelated processes without a daemon. A holder
 * that dies without releasing would deadlock every later invocation, so a lock
 * older than LOCK_STALE_MS is broken rather than waited on.
 *
 * Each holder writes a unique token into the lock file, and only unlinks the lock
 * if it still holds that token. Without the check, a holder that overran staleMs
 * (broken and replaced by another process) would unlink the SUCCESSOR's lock on
 * its way out, letting a third process in alongside the successor and defeating
 * the mutual exclusion.
 */
export async function withSessionLock<T>(
  path: string,
  fn: () => Promise<T>,
  { staleMs = LOCK_STALE_MS, timeoutMs = LOCK_STALE_MS * 2 } = {}
): Promise<T> {
  const lockPath = `${path}.lock`;
  mkdirSync(dirname(lockPath), { recursive: true });
  const token = `${process.pid}:${Date.now()}:${lockSeq++}`;
  const deadline = Date.now() + timeoutMs;
  let fd: number | null = null;

  while (fd === null) {
    try {
      fd = openSync(lockPath, "wx");
    } catch (err: any) {
      if (err?.code !== "EEXIST") throw err;
      let age = Infinity;
      try {
        age = Date.now() - statSync(lockPath).mtimeMs;
      } catch {
        // Holder released between our open and our stat — just retry the open.
        continue;
      }
      if (age > staleMs) {
        // Presumed-dead holder. unlink then retry; if a third process unlinks
        // first, our open simply wins on the next pass.
        try {
          unlinkSync(lockPath);
        } catch {
          // lost the race to clean up; harmless
        }
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for the DSM session lock at ${lockPath}. ` +
            `If no other syno process is running, delete that file.`
        );
      }
      await sleep(LOCK_POLL_MS);
    }
  }

  writeSync(fd, token);
  try {
    return await fn();
  } finally {
    closeSync(fd);
    try {
      // Only remove the lock if it is still ours. If we overran staleMs and
      // another process broke and recreated it, its token differs and we leave
      // it alone rather than unlink a healthy successor's lock.
      if (readFileSync(lockPath, "utf8") === token) unlinkSync(lockPath);
    } catch {
      // Gone already, or unreadable; nothing to clean up.
    }
  }
}

/**
 * Block until a TOTP code generated now would differ from the one that produced
 * `lastWindow`. Returns immediately in the common case (the previous login was
 * more than one window ago, or there was no previous login).
 *
 * This is the difference between "reuse is unlikely" and "reuse is impossible".
 * DSM answers a reused code with error 404 on login, which reads as a wrong
 * password rather than a rate limit, so it is worth waiting out rather than
 * retrying into.
 */
export async function awaitFreshTotpWindow(
  lastWindow: number | undefined,
  { now = () => Date.now(), delay = sleep }: TotpWaitDeps = {}
): Promise<number> {
  if (!lastWindow) return 0;
  const t = now();
  if (currentTotpWindow(t) !== lastWindow) return 0;
  const nextBoundary = (lastWindow + 1) * TOTP_WINDOW_MS;
  const waitMs = nextBoundary - t + TOTP_SKEW_CUSHION_MS;
  if (waitMs <= 0) return 0;
  console.error(
    `[syno] waiting ${(waitMs / 1000).toFixed(1)}s for a fresh 2FA code (the previous login used the current one)`
  );
  await delay(waitMs);
  return waitMs;
}
