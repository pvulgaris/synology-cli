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
  parseArgv,
  requiresConfirmation,
  resolveCommand,
} from "./commands.js";
import { VERSION } from "./version.js";

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

async function main(): Promise<number> {
  const raw = process.argv.slice(2);
  if (raw.length === 0 || raw[0] === "help" || raw[0] === "--help" || raw[0] === "-h") {
    console.log(helpText());
    return 0;
  }
  if (raw[0] === "--version" || raw[0] === "-v") {
    console.log(VERSION);
    return 0;
  }

  const { argv, flags } = parseArgv(raw);
  const resolved = resolveCommand(argv);
  if (!resolved) {
    console.error(`Unknown command: ${argv.join(" ")}\n`);
    console.error(helpText());
    return 2;
  }
  const { command, args } = resolved;

  if (requiresConfirmation(command, flags) && !(flags.yes === true || flags.yes === "true")) {
    console.error(
      `Refusing to run "${command.name}" without --yes.\n` +
        `This command changes state on the NAS. Re-run with --yes to confirm.`
    );
    return 2;
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
  console.log(JSON.stringify(result, null, 2));
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`[syno] ${err?.message ?? err}`);
    process.exit(1);
  });
