/**
 * Server config from env. All secrets are fetched separately via auth.ts (`op` CLI).
 *
 * Required:
 *   DSM_BASE_URL          e.g. https://localhost:5001 (in-container) or https://nas.local:5001 (laptop dev)
 *   DSM_OP_VAULT          1Password vault name holding the "Synology DSM" item
 *   DSM_OP_ITEM           1Password item name (default: "Synology DSM")
 *   DSM_USER              DSM account name (default: "claude-mcp")
 *
 * Optional:
 *   MCP_BIND_HOST         interface to bind HTTP transport (daemon mode); default: tailscale0 IP
 *   MCP_BIND_PORT         port for HTTP transport; default: 8765
 *   MCP_ALLOWED_ORIGINS   comma-separated Origin allowlist; default: localhost variants + null
 *   AUDIT_LOG_DIR         JSONL audit log directory; default: /volume1/docker/synology-nas-mcp/audit
 *   TLS_REJECT_UNAUTHORIZED  set "0" to skip cert validation for self-signed DSM certs (default: skip in dev)
 */

export interface Config {
  dsmBaseUrl: string;
  dsmUser: string;
  opVault: string;
  opItem: string;
  mcpBindHost: string | null;
  mcpBindPort: number;
  allowedOrigins: Set<string>;
  auditLogDir: string;
  /** When true, skip TLS cert verification — DSM ships with a self-signed cert
   *  out of the box, so this defaults true. Driven by the env var
   *  TLS_REJECT_UNAUTHORIZED ("0" → skip, anything else → enforce). */
  tlsSkipVerify: boolean;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env: ${name}`);
  return v;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

export function loadConfig(): Config {
  const dsmBaseUrl = required("DSM_BASE_URL").replace(/\/$/, "");
  const allowedOrigins = new Set(
    optional(
      "MCP_ALLOWED_ORIGINS",
      "http://localhost,http://127.0.0.1,null"
    )
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );
  return {
    dsmBaseUrl,
    dsmUser: optional("DSM_USER", "claude-mcp"),
    opVault: required("DSM_OP_VAULT"),
    opItem: optional("DSM_OP_ITEM", "Synology DSM"),
    mcpBindHost: process.env.MCP_BIND_HOST ?? null,
    mcpBindPort: parseInt(optional("MCP_BIND_PORT", "8765"), 10),
    allowedOrigins,
    auditLogDir: optional(
      "AUDIT_LOG_DIR",
      "/volume1/docker/synology-nas-mcp/audit"
    ),
    tlsSkipVerify: optional("TLS_REJECT_UNAUTHORIZED", "0") === "0",
  };
}
