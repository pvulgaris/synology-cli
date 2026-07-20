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
  mkdirSync,
  openSync,
  closeSync,
  unlinkSync,
  renameSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

/** TOTP step, in ms. RFC 6238's default and what DSM enforces. */
export const TOTP_WINDOW_MS = 30_000;

/** How long a cached SID is trusted. Matches the previous in-memory TTL. */
export const SID_TTL_MS = 10 * 60 * 1000;

/**
 * How long before a lock is presumed abandoned. A login is one HTTP round-trip
 * plus a credential read, so a healthy holder releases in well under a second;
 * the generous bound is for a holder that got SIGKILLed mid-login. It must stay
 * above TOTP_WINDOW_MS, since a holder legitimately waiting out a TOTP window
 * is not stuck.
 */
const LOCK_STALE_MS = 45_000;

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

export function defaultSessionPath(session: string): string {
  return join(stateDir(), `session-${session}.json`);
}

export function readSession(path: string): SessionRecord | null {
  try {
    const j = JSON.parse(readFileSync(path, "utf8"));
    if (typeof j?.sid === "string" && typeof j?.at === "number") {
      return { sid: j.sid, at: j.at, totpWindow: j.totpWindow ?? 0 };
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

/**
 * Hold an exclusive lock for `path` while `fn` runs.
 *
 * O_EXCL create is the lock: it is atomic on both local filesystems and, unlike
 * advisory locks, survives across unrelated processes without a daemon. A holder
 * that dies without releasing would deadlock every later invocation, so a lock
 * older than LOCK_STALE_MS is broken rather than waited on.
 */
export async function withSessionLock<T>(
  path: string,
  fn: () => Promise<T>,
  { staleMs = LOCK_STALE_MS, timeoutMs = LOCK_STALE_MS * 2 } = {}
): Promise<T> {
  const lockPath = `${path}.lock`;
  mkdirSync(dirname(lockPath), { recursive: true });
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

  try {
    return await fn();
  } finally {
    closeSync(fd);
    try {
      unlinkSync(lockPath);
    } catch {
      // Already broken as stale by another process; nothing to undo.
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
