/**
 * Credential provider: reads DSM password, TOTP secret, and the wire bearer token
 * from a 1Password item via the `op` CLI. Generates fresh TOTP codes on demand.
 *
 * The `op` CLI authenticates via OP_SERVICE_ACCOUNT_TOKEN env var (set on the container
 * project in DSM Container Manager). No interactive auth, no biometric prompts.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { authenticator } from "otplib";
import type { Config } from "./config.js";

const execFileP = promisify(execFile);

export interface Credentials {
  password: string;
  totpSecret: string;
  bearerToken: string;
}

async function opRead(ref: string): Promise<string> {
  try {
    const { stdout } = await execFileP("op", ["read", ref], {
      env: process.env,
      maxBuffer: 1024 * 1024,
    });
    return stdout.trim();
  } catch (err: any) {
    const detail = err?.stderr ?? err?.message ?? String(err);
    throw new Error(`op read ${ref} failed: ${detail}`);
  }
}

const MIN_BEARER_LEN = 32;

/** Fail closed on missing/degraded secrets. A blank or renamed 1Password
 *  field would otherwise let the daemon boot healthy with the wire bearer
 *  silently degraded to the 7-char constant "Bearer " — guessable by anyone
 *  who can reach the port. Refusing to start is the safer failure. */
function assertCredentials(c: Credentials): void {
  if (!c.password) {
    throw new Error("DSM password is empty — check the 1Password item or DSM_PASSWORD.");
  }
  if (!c.totpSecret) {
    throw new Error("DSM TOTP secret is empty — check the 1Password item or DSM_TOTP_SECRET.");
  }
  if (!c.bearerToken || c.bearerToken.length < MIN_BEARER_LEN) {
    throw new Error(
      `MCP bearer token missing or too short (${c.bearerToken?.length ?? 0} chars; need >= ${MIN_BEARER_LEN}). ` +
        `A blank/renamed 1Password field degrades wire auth to a guessable constant. Regenerate with: openssl rand -hex 32`
    );
  }
}

export async function loadCredentials(cfg: Config): Promise<Credentials> {
  // Env-var fast path. Useful for local dev: `source dev/source-creds.sh` once
  // (one Touch ID round-trip), then iterate without re-prompting 1Password on
  // every harness run. Production still uses `op read` via the service-account
  // token baked into the container.
  const envPw = process.env.DSM_PASSWORD;
  const envTotp = process.env.DSM_TOTP_SECRET;
  const envBearer = process.env.MCP_BEARER_TOKEN;
  let creds: Credentials;
  if (envPw && envTotp && envBearer) {
    creds = { password: envPw, totpSecret: envTotp, bearerToken: envBearer };
  } else {
    const base = `op://${cfg.opVault}/${cfg.opItem}`;
    const [password, totpSecret, bearerToken] = await Promise.all([
      envPw ?? opRead(`${base}/password`),
      envTotp ?? opRead(`${base}/totp`),
      envBearer ?? opRead(`${base}/mcp_bearer_token`),
    ]);
    creds = { password, totpSecret, bearerToken };
  }
  assertCredentials(creds);
  return creds;
}

export function currentTotpCode(secret: string): string {
  return authenticator.generate(secret);
}
