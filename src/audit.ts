/**
 * Append-only JSONL audit log for every write call. One file per month at
 * `<auditLogDir>/YYYY-MM.jsonl`. Reads are not logged.
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

export async function recordWrite(
  cfg: Config,
  rec: Omit<AuditRecord, "ts">
): Promise<void> {
  const ts = new Date().toISOString();
  const full: AuditRecord = { ts, ...rec };
  const month = ts.slice(0, 7); // YYYY-MM
  const file = path.join(cfg.auditLogDir, `${month}.jsonl`);
  await fs.mkdir(cfg.auditLogDir, { recursive: true, mode: 0o700 });
  await fs.appendFile(file, JSON.stringify(full) + "\n", { mode: 0o600 });
}
