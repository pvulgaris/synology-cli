/**
 * Append-only JSONL audit log for every write call. One file per month at
 * `<auditLogDir>/YYYY-MM.jsonl`. Reads are not logged.
 *
 * Storage mode is auto-selected at write time:
 *   - If MCP_AUDIT_URL is set, POST the entry to the deployed daemon's /audit
 *     endpoint. Used by dev tsx invocations so the canonical log lives on the
 *     NAS rather than fragmenting into local caches.
 *   - Otherwise, append to disk at <auditLogDir>/<month>.jsonl. Used by the
 *     daemon itself (where /audit is bind-mounted to /volume1 on the NAS).
 *
 * The log is the safety net for the "writes always prompt" policy: it gives the
 * user a paper trail of what Claude did, even if a confirmation slipped through.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { Config } from "./config.js";

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
  cfg: Config,
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
    thrownError = String(err?.message ?? err);
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
  cfg: Config,
  rec: AuditRecord
): Promise<void> {
  const month = rec.ts.slice(0, 7); // YYYY-MM
  const file = path.join(cfg.auditLogDir, `${month}.jsonl`);
  await fs.mkdir(cfg.auditLogDir, { recursive: true, mode: 0o700 });
  await fs.appendFile(file, JSON.stringify(rec) + "\n", { mode: 0o600 });
}

export async function recordWrite(
  cfg: Config,
  rec: Omit<AuditRecord, "ts">
): Promise<void> {
  const ts = new Date().toISOString();
  const full: AuditRecord = { ts, ...rec };

  const remoteUrl = process.env.MCP_AUDIT_URL;
  const bearer = process.env.MCP_BEARER_TOKEN;
  if (remoteUrl && bearer) {
    try {
      const res = await fetch(remoteUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${bearer}`,
        },
        body: JSON.stringify(full),
      });
      if (res.ok) return;
      const body = await res.text().catch(() => "");
      console.error(
        `[audit] remote POST ${remoteUrl} returned HTTP ${res.status}: ${body}. Falling back to local file.`
      );
    } catch (err: any) {
      console.error(
        `[audit] remote POST ${remoteUrl} threw: ${err?.message ?? err}. Falling back to local file.`
      );
    }
    // Fall through to local write so the entry isn't lost. Operator should
    // rsync the local file into the NAS audit dir to reunify the timeline.
  }

  await writeRecordToFile(cfg, full);
}

/** Server-side write path: append a pre-built AuditRecord (already includes
 *  `ts`). Used by the daemon's /audit HTTP endpoint after auth + validation. */
export async function appendAuditRecord(
  cfg: Config,
  rec: AuditRecord
): Promise<void> {
  await writeRecordToFile(cfg, rec);
}
