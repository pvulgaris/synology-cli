/**
 * Install-time credential acquisition (runs on the operator's Mac, not the NAS).
 *
 * Gathers the DSM admin password + TOTP seed from env (`DSM_PASSWORD` /
 * `DSM_TOTP_SECRET`) or a no-echo prompt, and — for a first install — generates a
 * fresh wire bearer locally. Values are held only in process memory: never written
 * to disk, never passed on argv (no --password flag), never logged. The caller
 * validates them with a live DSM login before anything is pushed to the NAS.
 *
 * 1Password users don't need a dedicated flag — run the tool under `op run` (or
 * export `DSM_PASSWORD=$(op read …)`), which is the sanctioned op idiom and keeps
 * the plaintext in RAM.
 */
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import { secretFromEnv } from "./auth.js";

export interface InstallCredentials {
  password: string;
  totpSecret: string;
  bearer: string;
}

/** Prompt on the TTY without echoing what's typed (for secrets). */
function promptHidden(query: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // Require BOTH stdin and stdout to be a TTY. readline derives terminal mode from
    // the OUTPUT stream, so if stdout is redirected (`install > log`, `| tee`) the
    // mute below never engages and the kernel echoes the typed secret into the sink.
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      reject(
        new Error(
          `cannot prompt for "${query.trim()}" without an interactive terminal. Provide it via ` +
            `env (DSM_PASSWORD / DSM_TOTP_SECRET), e.g. under \`op run\`.`
        )
      );
      return;
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    // Mute the echoed characters: write the prompt itself, hide the typed input.
    let shown = false;
    (rl as any)._writeToOutput = (str: string) => {
      if (!shown) {
        process.stdout.write(str);
        shown = true;
      }
      // subsequent writes (the echoed keystrokes) are swallowed
    };
    rl.question(query, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
  });
}

/**
 * Resolve the DSM login secrets (password + TOTP seed). Precedence:
 *   env DSM_PASSWORD / DSM_TOTP_SECRET  (op users: `op run -- synology-mcp …`)
 *   no-echo TTY prompt
 * Used by both install and update — update needs only these, not a bearer.
 */
export async function gatherDsmCredentials(): Promise<{ password: string; totpSecret: string }> {
  // Per FIELD (only one prefix in play, so an env password + a prompted TOTP is a
  // legitimate mix): resolve each from env or *_FILE via secretFromEnv, else no-echo
  // prompt. secretFromEnv SURFACES a misconfig (both `<NAME>` and `<NAME>_FILE` set, an
  // unreadable/symlinked file) as an exception rather than silently falling to a prompt.
  const password = secretFromEnv("DSM_PASSWORD") ?? (await promptHidden("DSM claude-mcp password: ")).trim();
  const totpSecret =
    secretFromEnv("DSM_TOTP_SECRET") ?? (await promptHidden("DSM TOTP seed (base32, not a 6-digit code): ")).trim();
  if (!password) throw new Error("DSM password is empty");
  if (!totpSecret) throw new Error("DSM TOTP seed is empty");
  return { password, totpSecret };
}

/**
 * As gatherDsmCredentials, plus a freshly generated wire bearer (32 random bytes,
 * hex) — install prints it once for client wiring; update never touches it.
 */
export async function gatherInstallCredentials(): Promise<InstallCredentials> {
  const { password, totpSecret } = await gatherDsmCredentials();
  // Install WRITES these into `*_FILE` secrets on the NAS, and the daemon reads files
  // back TRIMMED (auth.ts secretFromEnv → readFileSync().trim()). So trim here too —
  // otherwise a direct `DSM_PASSWORD` env with edge whitespace would validate at
  // install but the running daemon would read a different (trimmed) value from the file.
  return {
    password: password.trim(),
    totpSecret: totpSecret.trim(),
    bearer: randomBytes(32).toString("hex"),
  };
}
