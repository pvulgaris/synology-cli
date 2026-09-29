/**
 * Append-only JSONL audit log for every write call. One file per month at
 * `<auditLogDir>/YYYY-MM.jsonl`. Reads are not logged.
 *
 * Records are appended to disk at <auditLogDir>/<month>.jsonl. The default is
 * per-user state outside the repository.
 *
 * The log is the safety net for the "writes always prompt" policy: it gives the
 * user a record of what an agent changed, even if a confirmation slipped through.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { RuntimeConfig } from "./config.js";
import { errorMessage } from "./client.js";

export interface AuditRecord {
  ts: string;
  tool: string;
  args: Record<string, unknown>;
  before?: unknown;
  after?: unknown;
  ok: boolean;
  error?: string;
}

/** Run a write tool's body with a guaranteed audit log entry on both success
 *  and failure. `ctx` is a mutable bag the body can add partial-state fields
 *  to (task ids, intermediate paths) so the audit captures them even when the
 *  body throws halfway through. Returns the body's `{after, ok}` so the
 *  caller can construct its tool-specific response shape. */
export async function withAudit(
  cfg: RuntimeConfig,
  opts: {
    tool: string;
    args: Record<string, unknown>;
    before: unknown;
  },
  fn: (ctx: Record<string, unknown>) => Promise<{
    after: unknown;
    ok: boolean;
    error?: string;
  }>
): Promise<{ after: unknown; ok: boolean }> {
  const ctx: Record<string, unknown> = {};
  let result: { after: unknown; ok: boolean; error?: string } | undefined;
  let thrownError: string | undefined;
  try {
    result = await fn(ctx);
    return { after: result.after, ok: result.ok };
  } catch (err: any) {
    thrownError = errorMessage(err);
    throw err;
  } finally {
    await recordWrite(cfg, {
      tool: opts.tool,
      args: { ...opts.args, ...ctx },
      before: opts.before,
      after: result?.after ?? null,
      ok: result?.ok ?? false,
      error: result?.error ?? thrownError,
    });
  }
}

async function writeRecordToFile(
  cfg: RuntimeConfig,
  rec: AuditRecord
): Promise<void> {
  const month = rec.ts.slice(0, 7); // YYYY-MM
  const file = path.join(cfg.auditLogDir, `${month}.jsonl`);
  await fs.mkdir(cfg.auditLogDir, { recursive: true, mode: 0o700 });
  await fs.appendFile(file, JSON.stringify(rec) + "\n", { mode: 0o600 });
}

async function recordWrite(
  cfg: RuntimeConfig,
  rec: Omit<AuditRecord, "ts">
): Promise<void> {
  const ts = new Date().toISOString();
  const full: AuditRecord = { ts, ...rec };
  await writeRecordToFile(cfg, full);
}
