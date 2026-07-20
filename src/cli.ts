#!/usr/bin/env node

/**
 * syno — command-line access to a Synology NAS (DSM 7) and SRM router.
 *
 * Output contract, chosen for agent use as much as human use:
 *   - stdout is only ever the result, as JSON. Pipe it to jq without filtering.
 *   - stderr carries the DSM call trace and any error.
 *   - exit 0 on success, 1 on failure, 2 on a usage error.
 *
 * Required env: DSM_BASE_URL, plus credentials (see auth.ts — env, *_FILE, or a
 * launcher like `op run`). SRM_BASE_URL optionally adds the router.
 */

import { loadConfig } from "./config.js";
import { SynoClient, makeRouterClient } from "./dsm.js";
import {
  COMMANDS,
  UsageError,
  parseArgv,
  requiresConfirmation,
  resolveCommand,
} from "./commands.js";
import { VERSION } from "./version.js";

/** What to emit and with which code. Kept as data so the single exit path can
 *  flush the streams before the process ends (see `finish`). */
interface Outcome {
  code: number;
  stdout?: string;
  stderr?: string;
}

function helpText(): string {
  const lines = [
    `syno ${VERSION} — Synology NAS from the command line`,
    "",
    "Usage: syno <command> [args] [--flags]",
    "",
    "Commands:",
  ];
  const width = Math.max(
    ...COMMANDS.map((c) => `${c.name} ${c.usage ?? ""}`.trim().length)
  );
  for (const c of COMMANDS) {
    const invocation = `${c.name} ${c.usage ?? ""}`.trim();
    const mark = c.mutating ? " [write]" : "";
    lines.push(`  ${invocation.padEnd(width)}  ${c.summary}${mark}`);
  }
  lines.push(
    "",
    "Write commands require --yes. So does `raw --post`, since DSM treats POST as mutating.",
    "",
    "Every command prints JSON on stdout; the DSM call trace goes to stderr.",
    "Use `raw` for any endpoint without a named command — see docs/dsm-api-quirks.md",
    "for the form-encoding rules (string params need JSON quotes)."
  );
  return lines.join("\n");
}

async function main(): Promise<Outcome> {
  const raw = process.argv.slice(2);
  if (raw.length === 0 || raw[0] === "help" || raw[0] === "--help" || raw[0] === "-h") {
    return { code: 0, stdout: helpText() };
  }
  if (raw[0] === "--version" || raw[0] === "-v") {
    return { code: 0, stdout: VERSION };
  }

  const { argv, flags } = parseArgv(raw);
  const resolved = resolveCommand(argv);
  if (!resolved) {
    return { code: 2, stderr: `Unknown command: ${argv.join(" ")}\n\n${helpText()}` };
  }
  const { command, args } = resolved;

  if (requiresConfirmation(command, flags) && !(flags.yes === true || flags.yes === "true")) {
    return {
      code: 2,
      stderr:
        `Refusing to run "${command.name}" without --yes.\n` +
        `This command changes state on the NAS. Re-run with --yes to confirm.`,
    };
  }

  const cfg = loadConfig();
  // Process-wide TLS skip for DSM's self-signed cert. A per-fetch undici
  // dispatcher was tried and reverted: it interacted badly with Node's built-in
  // fetch (intermittent "fetch failed" and silently-empty responses). The blast
  // radius is bounded to DSM-shaped targets. Any non-Synology outbound added
  // later must route through its own verifying Agent to override this.
  if (cfg.tlsSkipVerify) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  }
  const dsm = new SynoClient(cfg);
  const router = makeRouterClient(cfg);

  const result = await command.run({ cfg, dsm, router, args, flags });
  return { code: 0, stdout: JSON.stringify(result, null, 2) };
}

/**
 * The single exit path. `process.exit()` discards whatever is still buffered in
 * stdout, so calling it straight after a write truncates a piped result into
 * invalid JSON. That breaks the whole point of a CLI you pipe to jq. So each
 * stream is drained (its write callback fires only once the data reaches the OS)
 * before the process ends.
 */
function finish(outcome: Outcome): void {
  const drain = (
    stream: NodeJS.WriteStream,
    text: string | undefined,
    next: () => void
  ) => {
    if (text === undefined) return next();
    stream.write(text.endsWith("\n") ? text : text + "\n", () => next());
  };
  drain(process.stdout, outcome.stdout, () =>
    drain(process.stderr, outcome.stderr, () => process.exit(outcome.code))
  );
}

main()
  .then(finish)
  .catch((err) => {
    // A malformed invocation is exit 2 (the documented usage code); anything else
    // is a runtime or DSM failure at exit 1. Both flush stderr before exiting.
    const code = err instanceof UsageError ? 2 : 1;
    finish({ code, stderr: `[syno] ${err?.message ?? err}` });
  });
