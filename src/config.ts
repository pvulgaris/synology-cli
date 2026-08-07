/** Runtime settings and independent Synology target configuration. */

import { join } from "node:path";
import { defaultSessionPath, stateDir } from "./session.js";

export type Platform = "dsm" | "srm";

export interface RuntimeConfig {
  auditLogDir: string;
  tlsSkipVerify: boolean;
}

/** Everything the client needs to authenticate to one Synology device. */
export interface TargetConfig {
  platform: Platform;
  baseUrl: string;
  user: string;
  envPrefix: "DSM" | "SRM";
  session: string;
  authVersion: number;
  authPath: string;
  sidCacheFile: string;
  readOnly: boolean;
}

type PlatformDefaults = Pick<
  TargetConfig,
  "envPrefix" | "session" | "authVersion" | "authPath" | "readOnly"
>;

const PLATFORMS: Record<Platform, PlatformDefaults> = {
  dsm: {
    envPrefix: "DSM",
    session: "syno-cli",
    authVersion: 6,
    authPath: "entry.cgi",
    readOnly: false,
  },
  srm: {
    envPrefix: "SRM",
    session: "syno-cli-router",
    authVersion: 3,
    authPath: "auth.cgi",
    readOnly: true,
  },
};

/** Empty or whitespace-only environment values are absent. */
function envValue(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : undefined;
}

export function loadRuntimeConfig(): RuntimeConfig {
  return {
    auditLogDir: process.env.AUDIT_LOG_DIR ?? join(stateDir(), "audit"),
    tlsSkipVerify: (process.env.TLS_REJECT_UNAUTHORIZED ?? "0") === "0",
  };
}

/** Load one target without inspecting configuration for the other platform. */
export function loadTarget(platform: Platform): TargetConfig {
  const defaults = PLATFORMS[platform];
  const baseUrlName = `${defaults.envPrefix}_BASE_URL`;
  const baseUrl = envValue(baseUrlName);
  if (!baseUrl) throw new Error(`Missing required env: ${baseUrlName}`);
  const user = envValue(`${defaults.envPrefix}_USER`) ?? "claude-mcp";
  return {
    platform,
    baseUrl: baseUrl.replace(/\/$/, ""),
    user,
    envPrefix: defaults.envPrefix,
    session: defaults.session,
    authVersion: defaults.authVersion,
    authPath: defaults.authPath,
    sidCacheFile:
      envValue(`${defaults.envPrefix}_SID_CACHE_FILE`) ??
      defaultSessionPath(defaults.session, baseUrl, user),
    readOnly: defaults.readOnly,
  };
}

/** Return null only when the target is not configured. Invalid target config fails. */
export function tryLoadTarget(platform: Platform): TargetConfig | null {
  const prefix = PLATFORMS[platform].envPrefix;
  return envValue(`${prefix}_BASE_URL`) ? loadTarget(platform) : null;
}
