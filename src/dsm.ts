/**
 * Thin DSM Web API client. Handles login (with TOTP), SID caching, and
 * automatic re-auth on 119 ("SID not found").
 *
 * Reference: Synology DSM Login Web API Guide; SYNO.API.* family endpoints.
 * We hit `entry.cgi` for almost everything (the unified DSM dispatcher).
 *
 * TLS: DSM ships with a self-signed cert by default. If
 * `cfg.tlsRejectUnauthorized` is false, the cli sets NODE_TLS_REJECT_UNAUTHORIZED=0
 * process-wide at startup. We do not paper over that here.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Config } from "./config.js";
import { currentTotpCode, loadCredentials, type Credentials } from "./auth.js";

const SID_TTL_MS = 10 * 60 * 1000; // 10 minutes

// Dev-only: persist the SID across `tsx` invocations so the harness doesn't
// burn a TOTP code on every run. DSM rejects reuse within the same 30s window
// with code 404 on login. In production the daemon stays up so this is a
// no-op; the env var is set only by dev/source-creds.sh.
function readSidCache(path: string): { sid: string; at: number } | null {
  try {
    const raw = readFileSync(path, "utf8");
    const j = JSON.parse(raw);
    if (typeof j?.sid === "string" && typeof j?.at === "number") return j;
  } catch {
    // missing or unparsable → treat as cache miss
  }
  return null;
}

function writeSidCache(path: string, sid: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ sid, at: Date.now() }), { mode: 0o600 });
  } catch {
    // best-effort; dev convenience only
  }
}

export interface DsmResponse<T = any> {
  success: boolean;
  data?: T;
  error?: { code: number; errors?: any[] };
}

export interface DsmCallOptions {
  api: string;
  method: string;
  /** API version. Pass a number for an explicit version, or "max" to use the
   *  value `SYNO.API.Info` reports as `maxVersion` for this API (cached after
   *  the first lookup). Default: 1. */
  version?: number | "max";
  params?: Record<string, string | number | boolean | undefined>;
  /** Use POST instead of GET (some mutating methods require it). */
  post?: boolean;
}

export class DsmError extends Error {
  constructor(
    public readonly api: string,
    public readonly method: string,
    public readonly code: number,
    public readonly errors: any[] | undefined,
    message: string
  ) {
    super(message);
    this.name = "DsmError";
  }
}

export class DsmClient {
  private creds: Credentials | null = null;
  private sid: string | null = null;
  private sidObtainedAt = 0;
  // Concurrent ensureSession() calls share the in-flight login. Without this,
  // a Promise.all of MCP tool calls fires N parallel logins that all reuse the
  // same 30s TOTP code; DSM accepts the first and 404s the rest.
  private loginInFlight: Promise<void> | null = null;
  // Cached SYNO.API.Info?query=all response: api name → {min, max}. Populated
  // lazily on first call that requests version:"max" so cold start isn't
  // penalised when nothing actually needs version negotiation.
  private apiVersions: Map<string, { min: number; max: number }> | null = null;
  private apiVersionsInFlight: Promise<void> | null = null;

  constructor(private cfg: Config) {
    const cachePath = process.env.DSM_SID_CACHE_FILE;
    if (cachePath) {
      const cached = readSidCache(cachePath);
      if (cached && Date.now() - cached.at < SID_TTL_MS) {
        this.sid = cached.sid;
        this.sidObtainedAt = cached.at;
      }
    }
  }

  private async ensureSession(): Promise<void> {
    if (!this.creds) this.creds = await loadCredentials(this.cfg);
    const fresh = this.sid && Date.now() - this.sidObtainedAt < SID_TTL_MS;
    if (fresh) return;
    if (!this.loginInFlight) {
      this.loginInFlight = this.login().finally(() => {
        this.loginInFlight = null;
      });
    }
    await this.loginInFlight;
  }

  private async login(): Promise<void> {
    if (!this.creds) this.creds = await loadCredentials(this.cfg);
    const otpCode = currentTotpCode(this.creds.totpSecret);
    const url = new URL(`${this.cfg.dsmBaseUrl}/webapi/entry.cgi`);
    url.searchParams.set("api", "SYNO.API.Auth");
    url.searchParams.set("version", "6");
    url.searchParams.set("method", "login");
    url.searchParams.set("account", this.cfg.dsmUser);
    url.searchParams.set("passwd", this.creds.password);
    url.searchParams.set("otp_code", otpCode);
    url.searchParams.set("format", "sid");
    url.searchParams.set("session", "synology-nas-mcp");

    const res = await fetch(url, { method: "GET" });
    const body = (await res.json()) as DsmResponse<{ sid: string }>;
    if (!body.success || !body.data?.sid) {
      const code = body.error?.code ?? -1;
      throw new DsmError(
        "SYNO.API.Auth",
        "login",
        code,
        body.error?.errors,
        `DSM login failed (code ${code}). Confirm the DSM user exists, has 2FA on, and that the 1Password item fields match.`
      );
    }
    this.sid = body.data.sid;
    this.sidObtainedAt = Date.now();
    const cachePath = process.env.DSM_SID_CACHE_FILE;
    if (cachePath) writeSidCache(cachePath, this.sid);
  }

  /**
   * Call any DSM API method. Auto-handles SID expiry by re-logging in once on
   * codes 117 or 119 and retrying.
   */
  async call<T = any>(opts: DsmCallOptions): Promise<T> {
    await this.ensureSession();
    const resolved = await this.resolveVersion(opts);
    try {
      return await this.callOnce<T>(resolved);
    } catch (err) {
      if (err instanceof DsmError && (err.code === 119 || err.code === 117)) {
        this.sid = null;
        await this.ensureSession();
        return await this.callOnce<T>(resolved);
      }
      throw err;
    }
  }

  /** Resolve a `version: "max"` opt-in into a concrete number by consulting
   *  SYNO.API.Info. No-op for numeric or omitted versions. */
  private async resolveVersion(opts: DsmCallOptions): Promise<DsmCallOptions> {
    if (opts.version !== "max") return opts;
    await this.ensureApiVersions();
    const entry = this.apiVersions?.get(opts.api);
    if (!entry) {
      throw new DsmError(
        opts.api,
        opts.method,
        -1,
        undefined,
        `Cannot resolve version "max" for ${opts.api}: not in SYNO.API.Info?query=all response. Pass an explicit version number.`
      );
    }
    return { ...opts, version: entry.max };
  }

  /** Lazy-load the full API.Info?query=all catalog. Single in-flight promise
   *  shared across concurrent callers (same shape as login). */
  private async ensureApiVersions(): Promise<void> {
    if (this.apiVersions) return;
    if (!this.apiVersionsInFlight) {
      this.apiVersionsInFlight = this.fetchApiVersions().finally(() => {
        this.apiVersionsInFlight = null;
      });
    }
    await this.apiVersionsInFlight;
  }

  private async fetchApiVersions(): Promise<void> {
    const data = await this.callOnce<any>({
      api: "SYNO.API.Info",
      method: "query",
      version: 1,
      params: { query: "all" },
    });
    const map = new Map<string, { min: number; max: number }>();
    for (const [api, info] of Object.entries(data ?? {})) {
      const min = Number((info as any)?.minVersion);
      const max = Number((info as any)?.maxVersion);
      if (Number.isFinite(min) && Number.isFinite(max)) {
        map.set(api, { min, max });
      }
    }
    this.apiVersions = map;
    console.error(`[dsm] cached ${map.size} API version entries from API.Info`);
  }

  /** Public helper: look up `maxVersion` for a given API. Returns null if the
   *  API isn't in the catalog. Forces a lazy fetch of API.Info on first call. */
  async getMaxVersion(api: string): Promise<number | null> {
    await this.ensureApiVersions();
    return this.apiVersions?.get(api)?.max ?? null;
  }

  private async callOnce<T>(opts: DsmCallOptions): Promise<T> {
    const url = new URL(`${this.cfg.dsmBaseUrl}/webapi/entry.cgi`);
    const body = new URLSearchParams();
    const add = (k: string, v: string | number | boolean | undefined) => {
      if (v === undefined) return;
      const target = opts.post ? body : url.searchParams;
      target.append(k, String(v));
    };
    add("api", opts.api);
    add("version", opts.version ?? 1);
    add("method", opts.method);
    if (this.sid) add("_sid", this.sid);
    for (const [k, v] of Object.entries(opts.params ?? {})) add(k, v);

    // Log every call so Container Manager's log tab has the full DSM trace.
    // Trim _sid + passwd so the log isn't a secret. Other params are fine —
    // they're the actual call shape, useful for debugging mismatches.
    const safeParams: Record<string, string> = {};
    const src = opts.post ? body : url.searchParams;
    src.forEach((v, k) => {
      if (k === "_sid" || k === "passwd" || k === "otp_code") return;
      safeParams[k] = v;
    });
    const verb = opts.post ? "POST" : "GET";
    console.error(`[dsm] → ${verb} ${opts.api}.${opts.method}`, safeParams);

    const init: RequestInit = opts.post
      ? {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: body.toString(),
        }
      : { method: "GET" };
    const res = await fetch(url, init);
    const json = (await res.json()) as DsmResponse<T>;
    if (!json.success) {
      const code = json.error?.code ?? -1;
      const errs = json.error?.errors;
      // Log the whole raw error payload — most DSM failure modes only make
      // sense when you can see the full response, not just the code.
      console.error(
        `[dsm] ✗ ${opts.api}.${opts.method} code=${code}`,
        JSON.stringify(json.error ?? {})
      );
      const detail = errs ? ` — ${JSON.stringify(errs)}` : "";
      throw new DsmError(
        opts.api,
        opts.method,
        code,
        errs,
        `${opts.api}.${opts.method} failed (code ${code})${detail}`
      );
    }
    if (process.env.DEBUG_DSM_RESPONSES === "1") {
      const blob = JSON.stringify(json.data ?? {});
      const trimmed = blob.length > 1500 ? blob.slice(0, 1500) + "…" : blob;
      console.error(`[dsm] ✓ ${opts.api}.${opts.method}`, trimmed);
    } else {
      console.error(`[dsm] ✓ ${opts.api}.${opts.method}`);
    }
    return (json.data ?? ({} as T));
  }

  hasSession(): boolean {
    return !!this.sid;
  }
}
