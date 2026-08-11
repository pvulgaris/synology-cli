/** Live smoke runner for public, argument-free read commands. */

import { COMMANDS, parseArgv, selectPlatform } from "../commands.js";
import {
  loadRuntimeConfig,
  loadTarget,
  tryLoadTarget,
  type Platform,
} from "../config.js";
import { SynoClient } from "../client.js";

async function main(): Promise<void> {
  const runtime = loadRuntimeConfig();
  if (runtime.tlsSkipVerify) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

  const { argv, flags } = parseArgv(process.argv.slice(2));
  const targetValue = flags.target;
  if (targetValue && targetValue !== "dsm" && targetValue !== "srm") {
    throw new Error("--target must be dsm or srm");
  }
  const target = targetValue as Platform | undefined;
  const filter = argv.join(" ");
  const configured = new Set(
    (["dsm", "srm"] as const).filter((platform) => tryLoadTarget(platform))
  );
  const eligible = COMMANDS.filter(
    (command) =>
      !command.mutating &&
      command.name !== "raw" &&
      (command.args?.length ?? 0) === 0 &&
      (target
        ? command.platforms.includes(target)
        : command.platforms.some((platform) => configured.has(platform))) &&
      (!filter || command.name === filter)
  );
  if (filter && eligible.length === 0) {
    throw new Error(`unknown or non-smoke command: ${filter}`);
  }

  let failures = 0;
  for (const command of eligible) {
    console.error(`\n=== ${command.name} ===`);
    try {
      const platform = selectPlatform(command, flags);
      const config = loadTarget(platform);
      const output = await command.run({
        runtime,
        target: config,
        client: new SynoClient(config),
        args: [],
        flags,
      });
      console.log(JSON.stringify(output, null, 2));
    } catch (err) {
      failures++;
      console.error(`FAIL: ${err instanceof Error ? err.message : err}`);
    }
  }
  if (failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("fatal:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
