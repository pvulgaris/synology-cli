/**
 * Credential provider: resolves the DSM/SRM login secrets (password, TOTP seed)
 * and the wire bearer token from the environment, then generates TOTP codes.
 *
 * Each secret resolves from the first source that provides it:
 *   1. `<NAME>_FILE` — read the secret from that file path (the Docker *_FILE
 *      convention). Keeps it out of the container environment, so it's invisible
 *      to `docker inspect`, /proc/<pid>/environ, and child processes. Mount a 0600
 *      file (ideally RAM-backed) and point `<NAME>_FILE` at it. See docs/SETUP.md.
 *   2. `<NAME>` — the secret value directly in an env var (simplest; weaker at-rest
 *      posture — it lands in the container config on disk and the env surfaces above).
 *
 * How the env/files get populated is up to the operator: write a file, export the
 * env directly, or fill it at launch with `op run` / sops / any secret manager.
 * The server has no built-in secret-manager dependency.
 */

import { readFileSync, lstatSync } from "node:fs";
import { authenticator } from "otplib";

/** Resolve a secret from a file (`<NAME>_FILE`, the Docker *_FILE convention) or
 *  a direct env var (`<NAME>`). The file form keeps the value out of the container
 *  environment — invisible to `docker inspect`, /proc/<pid>/environ, and child
 *  processes. Returns undefined when neither is set. Setting both is refused (fail
 *  closed on ambiguous config). File contents are trimmed — a trailing newline
 *  (`echo secret > file`) is not part of the secret; TOTP seeds, hex bearers, and
 *  passwords don't carry edge whitespace. */
export function secretFromEnv(name: string): string | undefined {
  const filePath = process.env[`${name}_FILE`];
  // Empty OR whitespace-only direct env (e.g. Container Manager injecting `${VAR:-}`
  // for an unset host var) means ABSENT — so *_FILE can win and the both-set guard
  // below doesn't trip on a blank var. A real value is kept untrimmed (a password may
  // legitimately carry edge spaces; only the *file* form trims a trailing newline).
  const rawDirect = process.env[name];
  const direct = rawDirect && rawDirect.trim() ? rawDirect : undefined;
  if (filePath && direct) {
    throw new Error(
      `Both ${name} and ${name}_FILE are set — set exactly one ` +
        `(the *_FILE form reads the secret from that file path).`
    );
  }
  if (filePath) {
    try {
      // Refuse to read through a symlink: a planted link would redirect the read at
      // an unintended target. Our secrets are real bind-mounted files, so this only
      // rejects a hostile link.
      if (lstatSync(filePath).isSymbolicLink()) {
        throw new Error(`${name}_FILE is a symlink — refusing to follow it.`);
      }
      // Empty/whitespace file → "" (fails closed downstream via assert*), NOT
      // undefined: an unreadable-but-set file is a misconfig to surface, not a
      // signal to fall through.
      return readFileSync(filePath, "utf8").trim();
    } catch (err: any) {
      // Re-raise our own explicit messages (symlink refusal) verbatim.
      if (err instanceof Error && err.message.includes("_FILE is a symlink")) throw err;
      // Report the variable name + errno only — never the value. If an operator
      // mistakenly puts the secret itself where the *path* goes, echoing it here
      // would leak the credential into the container log. errno (ENOENT/EACCES/
      // EISDIR) is enough to diagnose.
      throw new Error(`${name}_FILE could not be read (${err?.code ?? "unreadable"}) — check the path.`);
    }
  }
  // `direct` is already undefined for an empty/whitespace var (normalized above), so
  // an absent secret stays undefined and callers fall through / fail closed.
  return direct;
}

/** The login secrets a SynoClient actually needs (NAS or router). */
export interface DsmOnlyCredentials {
  password: string;
  totpSecret: string;
}

/** The MCP's own full credential set: DSM login secrets + the wire bearer. */
export interface Credentials extends DsmOnlyCredentials {
  bearerToken: string;
}

/** Resolve one env prefix as a complete login-credential PAIR (password + TOTP).
 *  Returns undefined when the prefix is entirely absent — the caller MAY fall through
 *  to the next source. A HALF-set pair throws: a partial override must never silently
 *  mix identities with a different source (e.g. DSM_DEPLOY_USER + the runtime
 *  DSM_PASSWORD). Any secretFromEnv misconfig (both `<NAME>` and `<NAME>_FILE` set,
 *  unreadable/symlinked file) propagates verbatim — a fall-through can never mask it. */
export function credsFromPrefix(prefix: string): DsmOnlyCredentials | undefined {
  const password = secretFromEnv(`${prefix}_PASSWORD`);
  const totpSecret = secretFromEnv(`${prefix}_TOTP_SECRET`);
  if (password === undefined && totpSecret === undefined) return undefined;
  if (password === undefined || totpSecret === undefined) {
    throw new Error(
      `${prefix}_PASSWORD and ${prefix}_TOTP_SECRET must be set together (env or *_FILE) — ` +
        `a half-set pair would fall through to a different identity.`
    );
  }
  return { password, totpSecret };
}

const MIN_BEARER_LEN = 32;

/** Fail closed on missing login secrets — a blank/unset secret should refuse to
 *  start, not boot degraded. Applies to both NAS and router creds. */
function assertDsmCreds(c: DsmOnlyCredentials, label: string): void {
  if (!c.password) {
    throw new Error(`${label} password is empty — set ${label}_PASSWORD or ${label}_PASSWORD_FILE.`);
  }
  if (!c.totpSecret) {
    throw new Error(`${label} TOTP secret is empty — set ${label}_TOTP_SECRET or ${label}_TOTP_SECRET_FILE.`);
  }
}

/** A blank/unset bearer would otherwise degrade wire auth to the 7-char constant
 *  "Bearer " — guessable by anyone who can reach the port. */
function assertBearer(bearerToken: string): void {
  if (!bearerToken || bearerToken.length < MIN_BEARER_LEN) {
    throw new Error(
      `MCP bearer token missing or too short (${bearerToken?.length ?? 0} chars; need >= ${MIN_BEARER_LEN}). ` +
        `Set MCP_BEARER_TOKEN or MCP_BEARER_TOKEN_FILE — a blank source degrades wire auth to a ` +
        `guessable constant. Regenerate with: openssl rand -hex 32`
    );
  }
}

/** The MCP's full credentials: DSM login secrets + the wire bearer, from env/*_FILE.
 *  Async only to satisfy the SynoClient credLoader contract; the work is synchronous. */
export async function loadCredentials(): Promise<Credentials> {
  const bearerToken = secretFromEnv("MCP_BEARER_TOKEN") ?? "";
  assertBearer(bearerToken);
  return { ...(await loadDsmOnlyCredentials("DSM")), bearerToken };
}

/** Load just the login secrets (password + totp) for a target — used by the daemon
 *  and the router client (which has no bearer). Resolves the `<envPrefix>_*` pair
 *  (env or *_FILE, e.g. SRM_*) and fails closed on a blank/absent secret. */
export async function loadDsmOnlyCredentials(envPrefix = "DSM"): Promise<DsmOnlyCredentials> {
  const creds = credsFromPrefix(envPrefix) ?? { password: "", totpSecret: "" };
  assertDsmCreds(creds, envPrefix);
  return creds;
}

export function currentTotpCode(secret: string): string {
  return authenticator.generate(secret);
}
