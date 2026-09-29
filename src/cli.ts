#!/usr/bin/env node

/**
 * syno — command-line access to a Synology NAS (DSM 7) and SRM router.
 *
 * Output contract, chosen for agent use as much as human use:
 *   - stdout is only ever the result, as JSON. Pipe it to jq without filtering.
 *   - stderr carries concise progress and errors; --verbose adds the API trace.
 *   - exit 0 on success, 1 on failure, 2 on a usage error, 3 when `state`
 *     finds drift.
 *
 * Each command loads only its selected DSM or SRM target and credentials.
 */

import { loadRuntimeConfig, loadTarget } from "./config.js";
import { SynoClient, errorMessage } from "./client.js";
import {
  COMMANDS,
  UsageError,
  commandManifest,
  commandUsage,
  parseArgv,
  requiresConfirmation,
  resolveCommand,
  selectPlatform,
  validateInvocation,
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
    `syno ${VERSION}: Synology devices from the command line`,
    "",
    "Usage: syno <command> [args] [--flags]",
    "",
    "Commands:",
  ];
  const width = Math.max(
    ...COMMANDS.map((c) => `${c.name} ${commandUsage(c)}`.trim().length)
  );
  for (const c of COMMANDS) {
    const invocation = `${c.name} ${commandUsage(c)}`.trim();
    const mark = c.mutating ? " [write]" : "";
    lines.push(`  ${invocation.padEnd(width)}  ${c.summary}${mark}`);
  }
  lines.push(
    "",
    "Write commands require --yes. `raw` also requires it for POST or any non-read method unless the endpoint is known to be read-only.",
    "",
    "Every command prints JSON on stdout; progress and errors go to stderr.",
    "Use --verbose to add the Synology API trace to stderr.",
    "Use --target=dsm|srm when a command supports both platforms.",
    "Use `raw` for any endpoint without a named command."
  );
  return lines.join("\n");
}

async function main(): Promise<Outcome> {
  const raw = process.argv.slice(2);
  if (raw.length === 0 || raw[0] === "help" || raw[0] === "--help" || raw[0] === "-h") {
    const json = raw.includes("--json");
    return {
      code: 0,
      stdout: json
        ? JSON.stringify({ version: VERSION, commands: commandManifest() }, null, 2)
        : helpText(),
    };
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
  validateInvocation(command, args, flags);

  if (requiresConfirmation(command, flags, args) && !(flags.yes === true || flags.yes === "true")) {
    return {
      code: 2,
      stderr:
        `Refusing to run "${command.name}" without --yes.\n` +
        `This command may change device state. Re-run with --yes to confirm.`,
    };
  }

  const runtime = loadRuntimeConfig();
  // Process-wide TLS skip for Synology's self-signed certificates. A per-fetch undici
  // dispatcher was tried and reverted: it interacted badly with Node's built-in
  // fetch (intermittent "fetch failed" and silently-empty responses). The blast
  // radius is bounded to Synology targets. Any non-Synology outbound added
  // later must route through its own verifying Agent to override this.
  if (runtime.tlsSkipVerify) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  }
  const verbose = flags.verbose === true || flags.verbose === "true";
  const platform = selectPlatform(command, flags);
  let target;
  try {
    target = loadTarget(platform);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Missing required env:")) {
      throw new UsageError(err.message);
    }
    throw err;
  }
  const client = new SynoClient(target, { verbose });
  const result = await command.run({ runtime, target, client, args, flags });
  return { code: command.exitCode?.(result) ?? 0, stdout: JSON.stringify(result, null, 2) };
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
    // is a runtime or API failure at exit 1. Both flush stderr before exiting.
    const code = err instanceof UsageError ? 2 : 1;
    finish({ code, stderr: `[syno] ${errorMessage(err)}` });
  });
