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

/** The variable whose presence decides whether a target is configured at all. */
export function baseUrlEnvName(platform: Platform): string {
  return `${PLATFORMS[platform].envPrefix}_BASE_URL`;
}

/** Load one target without inspecting configuration for the other platform. */
export function loadTarget(platform: Platform): TargetConfig {
  const defaults = PLATFORMS[platform];
  const baseUrlName = baseUrlEnvName(platform);
  const configured = envValue(baseUrlName);
  if (!configured) throw new Error(`Missing required env: ${baseUrlName}`);
  // Both spellings address one device, so both must resolve to one session file.
  // A second login inside the window that minted the first SID is rejected.
  const baseUrl = configured.replace(/\/$/, "");
  // No fallback account name. A default that names no real account turns every
  // run without the variable into a failed login, which DSM and Active Insight
  // record against the NAS.
  const userName = `${defaults.envPrefix}_USER`;
  const user = envValue(userName);
  if (!user) throw new Error(`Missing required env: ${userName}`);
  return {
    platform,
    baseUrl,
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
  return envValue(baseUrlEnvName(platform)) ? loadTarget(platform) : null;
}
