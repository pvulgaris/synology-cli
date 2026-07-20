/**
 * Server config from env. Secrets themselves are resolved separately in auth.ts
 * (from `<NAME>_FILE`, a direct env var, or `op` — see its header).
 *
 * Required:
 *   DSM_BASE_URL          e.g. https://localhost:5001 (in-container) or https://nas.local:5001 (laptop dev)
 *   DSM_USER              DSM account name (default: "claude-mcp")
 *
 * Secrets (password, TOTP seed, wire bearer) are resolved in auth.ts from
 * `<NAME>_FILE` or a direct env var — populate them however you like (write a
 * file, export the env, or fill it at launch with `op run` / sops). No built-in
 * secret-manager dependency.
 *
 * Optional:
 *   MCP_BIND_HOST         interface to bind HTTP transport (daemon mode); default: tailscale0 IP
 *   MCP_BIND_PORT         port for HTTP transport; default: 8765
 *   MCP_ALLOWED_ORIGINS   comma-separated Origin allowlist; default: localhost variants + null
 *   AUDIT_LOG_DIR         JSONL audit log directory; default: /volume1/docker/synology-mcp/audit
 *   TLS_REJECT_UNAUTHORIZED  set "0" to skip cert validation for self-signed DSM certs (default: skip in dev)
 *
 * Optional — router (SRM) target, all back-compat (unset = NAS-only):
 *   SRM_BASE_URL       e.g. https://router.local:8001 (presence alone enables the router)
 *   SRM_USER           dedicated SRM admin account name (default: "claude-mcp", read-only usage)
 *   SRM_PASSWORD / SRM_TOTP_SECRET (or *_FILE)  router login secrets
 */

import { join } from "node:path";
import { defaultSessionPath, stateDir } from "./session.js";

/** Optional second target: the Synology router (SRM). SRM speaks the same
 *  SYNO.* Web API as DSM on port 8001. Its package/upgrade reads are admin-gated
 *  (no selective grant), so `user` must be an admin — use a *dedicated* SRM admin
 *  (claude-mcp-style; SRM supports extra admins via "Grant administrator
 *  privilege"), not the primary login. Read-only is enforced by the SynoClient
 *  read-only mode. null unless SRM_BASE_URL is set. */
export interface RouterTarget {
  baseUrl: string;
  user: string;
}

/** The exact slice of Config a `SynoClient` (and its cred loader) reads to talk to
 *  one Synology target — DSM or SRM. Every DSM↔SRM difference lives in these
 *  fields, so "which device" is fully expressed as data of this shape rather than
 *  as a class hierarchy or runtime branching. `Config` structurally satisfies it,
 *  so the NAS client passes the whole Config unchanged; `routerTargetFrom` builds
 *  the router's slice explicitly. Deliberately omits server-only fields
 *  (bind host, origins, audit dir) and `tlsSkipVerify` — the latter is applied
 *  process-wide at startup (cli.ts), never read through a target. */
export type TargetConfig = Pick<
  Config,
  | "baseUrl"
  | "user"
  | "session"
  | "authVersion"
  | "authPath"
  | "sidCacheFile"
>;

export interface Config {
  /** Base URL of the target device (the NAS for the main Config; the router for
   *  a projected router target). Sourced from DSM_BASE_URL / SRM_BASE_URL. */
  baseUrl: string;
  /** Login account on the target. Sourced from DSM_USER / SRM_USER. */
  user: string;
  auditLogDir: string;
  /** When true, skip TLS cert verification — DSM ships with a self-signed cert
   *  out of the box, so this defaults true. Driven by the env var
   *  TLS_REJECT_UNAUTHORIZED ("0" → skip, anything else → enforce). */
  tlsSkipVerify: boolean;
  /** DSM login `session` label. Per-instance so a second (router) client logs in
   *  under a distinct session for clear server-side bookkeeping. */
  session: string;
  /** `SYNO.API.Auth` version used at login. DSM 7 uses v6; SRM's auth API caps at
   *  v3 (confirmed via SYNO.API.Info: auth.cgi min=1/max=3), so logging into the
   *  router with v6 fails with code 102. Per-instance so each target logs in at a
   *  version it supports. */
  authVersion: number;
  /** Web API path for the login call. DSM accepts `SYNO.API.Auth` at entry.cgi;
   *  SRM routes it only at auth.cgi (SYNO.API.Info reports path=auth.cgi and 102s
   *  on entry.cgi). Per-instance; data calls always go to entry.cgi. */
  authPath: string;
  /** Optional dev-only SID cache path. Per-instance so the router client can't
   *  stomp the NAS client's cached SID. Undefined → no cache (production). */
  sidCacheFile?: string;
  router: RouterTarget | null;
}

/** Runtime state that is regenerable but not free to lose (audit log, sessions). */
function defaultStatePath(...parts: string[]): string {
  return join(stateDir(), ...parts);
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env: ${name}`);
  return v;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

/** Read an env var where empty/whitespace means UNSET — returns the trimmed value
 *  or undefined. One place for the "a blank override falls through to the next
 *  source" rule (used by the deploy login), instead of re-deriving it inline. */
export function envValue(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : undefined;
}

export function loadConfig(): Config {
  const baseUrl = required("DSM_BASE_URL").replace(/\/$/, "");
  const session = "syno-cli";
  const user = optional("DSM_USER", "claude-mcp");
  return {
    baseUrl,
    user,
    auditLogDir: optional("AUDIT_LOG_DIR", defaultStatePath("audit")),
    tlsSkipVerify: optional("TLS_REJECT_UNAUTHORIZED", "0") === "0",
    session,
    authVersion: 6,
    authPath: "entry.cgi",
    // Always set, unlike the daemon where this was an opt-in dev convenience.
    // Every invocation is a fresh process, so without a session file each one
    // would burn a login and a TOTP window. Keyed on baseUrl+user so a different
    // target or account can't adopt this one's SID. See session.ts.
    sidCacheFile:
      envValue("DSM_SID_CACHE_FILE") ?? defaultSessionPath(session, baseUrl, user),
    router: parseRouter(),
  };
}

/** Read the optional router target. Presence of SRM_BASE_URL alone gates it;
 *  SRM_USER defaults to the dedicated-claude-mcp convention (see RouterTarget).
 *  SRM_USER must NOT be required() here: parseRouter runs
 *  inside loadConfig, so a missing required env would throw and take down the
 *  entire NAS daemon at boot — not just the optional router. */
function parseRouter(): RouterTarget | null {
  const baseUrl = process.env.SRM_BASE_URL?.replace(/\/$/, "");
  if (!baseUrl) return null;
  return {
    baseUrl,
    // `|| ` not optional()'s `??`: Container Manager injects `SRM_USER:
    // ${SRM_USER:-}`, i.e. an empty string (not unset) when the host var is
    // absent — `??` would keep "" and log in with account="". Fall back (and
    // trim) so the dedicated-admin default actually applies in the Docker path.
    user: process.env.SRM_USER?.trim() || "claude-mcp",
  };
}

/** Build the router's target slice from the main Config: the router's base URL,
 *  admin user, a distinct session, SRM's auth path/version, and NO SID cache — the
 *  router always fresh-logs-in. (A dev disk
 *  SID cache was tried and reverted: SRM expires sessions faster than the client's
 *  10-min TTL, so a cached SID goes stale → 119 → re-login → TOTP-reuse 404. Fresh
 *  login per process is reliable; the production daemon keeps its SID warm
 *  in-memory regardless. The back-to-back-within-30s dev case just waits a TOTP
 *  window.)
 *
 *  The router now gets a session file too. The daemon deliberately withheld one
 *  because SRM expires sessions faster than the 10-minute TTL, so a cached SID
 *  went stale → 119 → re-login inside the same TOTP window → 404. That failure
 *  mode is exactly what session.ts now handles: a re-login after a rejected SID
 *  waits out the TOTP window rather than burning it. Withholding the cache from a
 *  per-process CLI would instead guarantee a login on every single router call.
 *
 *  Returns a `TargetConfig`, not a `Config`: the projected value describes the
 *  router *as a target*, so it structurally can't carry a `router` field —
 *  `makeRouterClient(routerTargetFrom(cfg))` is a compile error, not a runtime
 *  guard, and no server-only fields leak into a value that only feeds a client. */
export function routerTargetFrom(cfg: Config): TargetConfig {
  if (!cfg.router) {
    throw new Error("routerTargetFrom called without cfg.router");
  }
  return {
    baseUrl: cfg.router.baseUrl,
    user: cfg.router.user,
    session: `${cfg.session}-router`,
    authVersion: 3,
    authPath: "auth.cgi",
    sidCacheFile: defaultSessionPath(
      `${cfg.session}-router`,
      cfg.router.baseUrl,
      cfg.router.user
    ),
  };
}
