/**
 * Command registry.
 *
 * One table, because everything that needs to know the command surface derives
 * from it: dispatch, `--help`, and the skill's generated command list. A command
 * added here needs no other edit to become invocable and documented.
 *
 * Every command returns a plain value that the CLI prints as JSON. Response
 * shapes are deliberately unchanged from the MCP tools they replace — the
 * `synology` skill asserts on specific fields (`firewall_enabled`,
 * `web_hardening.https_redirect`, `smb.min_protocol`) to map findings to audit
 * IDs, so reshaping output here would silently break those rules.
 */

import type { Config } from "./config.js";
import type { SynoClient } from "./dsm.js";
import { nasStatus, nasStorageHealth } from "./tools/system.js";
import {
  nasPackagesList,
  nasPackagesCheckUpdates,
  nasPackageInfo,
  nasPackageInstall,
  nasPackageUninstall,
  nasPackageUpdate,
  nasPackageControl,
} from "./tools/packages.js";
import {
  nasSecurityAdvisorScan,
  nasUsersList,
  nasFirewallList,
  nasDsmSecuritySettings,
} from "./tools/security.js";
import { nasSharesList } from "./tools/shares.js";
import { nasExternalAccess } from "./tools/external.js";
import { nasNotifications } from "./tools/notifications.js";
import { nasCertificates } from "./tools/certificates.js";
import { nasDsmOsCheckUpdate, synologyUpdateDigest } from "./tools/updates.js";
import { routerSrmOsCheckUpdate } from "./tools/router.js";
import { nasHyperbackupTasks, nasShareSnapshots } from "./tools/backup.js";
import { nasTaskschedulerList } from "./tools/scheduler.js";

export interface CommandContext {
  cfg: Config;
  dsm: SynoClient;
  router: SynoClient | null;
  /** Positional arguments after the command path. */
  args: string[];
  /** Parsed `--flag` / `--flag=value` tokens. Bare flags are `true`. */
  flags: Record<string, string | true>;
}

export interface Command {
  /** Space-joined command path, e.g. "packages install". */
  name: string;
  summary: string;
  /** Usage suffix shown after the command name in help, e.g. "<name> [--version=X]". */
  usage?: string;
  /**
   * Mutating commands require an explicit --yes. The daemon relied on the MCP
   * client to prompt before invoking a write tool; a CLI has no such client, so
   * the confirmation gate has to live here or it does not exist at all.
   */
  mutating?: boolean;
  run(ctx: CommandContext): Promise<unknown>;
}

/** Positional argument or a clear error naming what was expected. */
function arg(ctx: CommandContext, index: number, name: string): string {
  const v = ctx.args[index];
  if (!v) throw new Error(`missing required argument <${name}>`);
  return v;
}

function boolFlag(ctx: CommandContext, name: string): boolean {
  const v = ctx.flags[name];
  return v === true || v === "true";
}

function strFlag(ctx: CommandContext, name: string): string | undefined {
  const v = ctx.flags[name];
  return typeof v === "string" ? v : undefined;
}

function requireRouter(ctx: CommandContext): SynoClient {
  if (!ctx.router) {
    throw new Error(
      "no router configured — set SRM_BASE_URL to enable router commands"
    );
  }
  return ctx.router;
}

export const COMMANDS: Command[] = [
  // ── System ────────────────────────────────────────────────────────────────
  {
    name: "status",
    summary: "DSM system status: model, version, uptime, temperature, CPU/memory load.",
    run: ({ dsm }) => nasStatus(dsm),
  },
  {
    name: "storage",
    summary: "Volumes (status, used/free, RAID level) and drives (S.M.A.R.T., temp, model).",
    run: ({ dsm }) => nasStorageHealth(dsm),
  },

  // ── Shares & snapshots ────────────────────────────────────────────────────
  {
    name: "shares list",
    summary:
      "Shared folders with encryption, quota, recycle-bin, snapshot support, BTRFS COW flag.",
    run: ({ dsm }) => nasSharesList(dsm),
  },
  {
    name: "shares snapshots",
    summary:
      "Btrfs snapshots for one share: timestamps, immutable/WORM lock state and window, newest/oldest, immutable count.",
    usage: "<share>",
    run: (ctx) => nasShareSnapshots(ctx.dsm, { share: arg(ctx, 0, "share") }),
  },

  // ── Backup & scheduled tasks ──────────────────────────────────────────────
  {
    name: "backup tasks",
    summary:
      "Hyper Backup tasks: destination, client-side encryption, schedule, last result, next run.",
    run: ({ dsm }) => nasHyperbackupTasks(dsm),
  },
  {
    name: "tasks list",
    summary: "DSM Task Scheduler entries with schedule and script notification config.",
    run: ({ dsm }) => nasTaskschedulerList(dsm),
  },

  // ── Packages ──────────────────────────────────────────────────────────────
  {
    name: "packages list",
    summary: "Installed packages with versions, running state, and is_system flag.",
    run: ({ dsm }) => nasPackagesList(dsm),
  },
  {
    name: "packages updates",
    summary: "Packages with pending updates from the Synology repo (excludes DSM self-update).",
    run: ({ dsm }) => nasPackagesCheckUpdates(dsm),
  },
  {
    name: "packages info",
    summary: "Metadata for one package: publisher, description, changelog, dependencies, size.",
    usage: "<name>",
    run: (ctx) => nasPackageInfo(ctx.dsm, { name: arg(ctx, 0, "name") }),
  },
  {
    name: "packages install",
    summary:
      "Install a package. Refuses DSM/kernel and already-installed packages. Without --accept-dependencies, a package with dependencies returns the plan instead of installing.",
    usage: "<name> [--version=X] [--accept-dependencies]",
    mutating: true,
    run: (ctx) =>
      nasPackageInstall(ctx.cfg, ctx.dsm, {
        name: arg(ctx, 0, "name"),
        version: strFlag(ctx, "version"),
        accept_dependencies: boolFlag(ctx, "accept-dependencies"),
      }),
  },
  {
    name: "packages update",
    summary:
      "Update a package to the latest version. Refuses DSM/kernel and already-current packages. Verifies post-state.",
    usage: "<name>",
    mutating: true,
    run: (ctx) => nasPackageUpdate(ctx.cfg, ctx.dsm, { name: arg(ctx, 0, "name") }),
  },
  {
    name: "packages uninstall",
    summary:
      "Uninstall a package, PRESERVING its data. Requires --keep-data to proceed. Data deletion is not supported here; use the DSM UI.",
    usage: "<name> [--keep-data]",
    mutating: true,
    run: (ctx) =>
      nasPackageUninstall(ctx.cfg, ctx.dsm, {
        name: arg(ctx, 0, "name"),
        keep_data: boolFlag(ctx, "keep-data"),
      }),
  },
  {
    name: "packages control",
    summary: "Start/stop/restart a package. Idempotent; verifies via status poll.",
    usage: "<name> <start|stop|restart>",
    mutating: true,
    run: (ctx) => {
      const action = arg(ctx, 1, "start|stop|restart");
      if (action !== "start" && action !== "stop" && action !== "restart") {
        throw new Error(`invalid action "${action}" — expected start, stop, or restart`);
      }
      return nasPackageControl(ctx.cfg, ctx.dsm, { name: arg(ctx, 0, "name"), action });
    },
  },

  // ── Security ──────────────────────────────────────────────────────────────
  {
    name: "security scan",
    summary:
      "Run DSM Security Advisor; returns per-status check counts plus the failing rules. Polls until the async scan finishes.",
    run: ({ dsm }) => nasSecurityAdvisorScan(dsm),
  },
  {
    name: "security settings",
    summary:
      "DSM hardening posture: web/TLS, SSH/Telnet, SMB, NFS, auto-update, password policy, telemetry.",
    run: ({ dsm }) => nasDsmSecuritySettings(dsm),
  },
  {
    name: "security firewall",
    summary:
      "Firewall profiles, auto-block (failed-login lockout), and per-adapter DoS protection.",
    run: ({ dsm }) => nasFirewallList(dsm),
  },
  {
    name: "users list",
    summary: "DSM user accounts: name, uid, 2FA state, expired flag, email.",
    run: ({ dsm }) => nasUsersList(dsm),
  },
  {
    name: "external",
    summary:
      "External-facing posture: QuickConnect, DDNS, App Portal, reverse proxy, port forwarding.",
    run: ({ dsm }) => nasExternalAccess(dsm),
  },
  {
    name: "notifications",
    summary: "SMTP notification config: server, port, SSL, verify-cert, sender, recipient count.",
    run: ({ dsm }) => nasNotifications(dsm),
  },
  {
    name: "certificates",
    summary: "DSM certificates with derived days_until_expiry per cert.",
    run: ({ dsm }) => nasCertificates(dsm),
  },

  // ── Updates ───────────────────────────────────────────────────────────────
  {
    name: "updates",
    summary:
      "Aggregated pending updates across DSM OS, NAS packages, router OS, and router packages, in one result.",
    run: ({ dsm, router }) => synologyUpdateDigest(dsm, router),
  },
  {
    name: "dsm update-check",
    summary: "Whether a DSM OS update is available (read-only; does not download or apply).",
    run: ({ dsm }) => nasDsmOsCheckUpdate(dsm),
  },
  {
    name: "router update-check",
    summary: "Whether an SRM router OS update is available (read-only).",
    run: (ctx) => routerSrmOsCheckUpdate(requireRouter(ctx)),
  },

  // ── Escape hatch ──────────────────────────────────────────────────────────
  {
    name: "raw",
    summary:
      "Call any DSM Web API endpoint directly. Params are form-encoded k=v; strings need JSON quoting (name='\"FileStation\"'). GET unless --post.",
    usage: "<api> <method> [--version=N] [--post] [k=v ...]",
    run: (ctx) => {
      const api = arg(ctx, 0, "api");
      const method = arg(ctx, 1, "method");
      const params: Record<string, string> = {};
      for (const tok of ctx.args.slice(2)) {
        const eq = tok.indexOf("=");
        if (eq < 0) {
          throw new Error(`unparsable param "${tok}" — expected k=v`);
        }
        params[tok.slice(0, eq)] = tok.slice(eq + 1);
      }
      const versionFlag = strFlag(ctx, "version");
      // POST is a write in DSM's eyes, so it goes through the same --yes gate as
      // the named write commands; see cli.ts. A GET raw call stays free.
      return ctx.dsm.call({
        api,
        method,
        version: versionFlag ? parseInt(versionFlag, 10) : 1,
        post: boolFlag(ctx, "post"),
        params,
      });
    },
  },
];

export interface Parsed {
  argv: string[];
  flags: Record<string, string | true>;
}

/**
 * Split flags from positionals. `--` stops flag parsing, which `raw` needs: a
 * DSM param can legitimately look like a flag, so
 * `raw SYNO.Foo get -- --version=3` passes a literal `--version=3` param
 * rather than setting the API version.
 */
export function parseArgv(input: string[]): Parsed {
  const argv: string[] = [];
  const flags: Record<string, string | true> = {};
  let literal = false;
  for (const tok of input) {
    if (literal) {
      argv.push(tok);
      continue;
    }
    if (tok === "--") {
      literal = true;
      continue;
    }
    if (tok.startsWith("--")) {
      const body = tok.slice(2);
      const eq = body.indexOf("=");
      if (eq < 0) flags[body] = true;
      else flags[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    argv.push(tok);
  }
  return { argv, flags };
}

/**
 * Writes need an explicit --yes. Under MCP the client prompted the user before
 * invoking a write tool; nothing plays that role for a CLI, so without this an
 * agent composing commands could uninstall a package with no confirmation step.
 */
export function requiresConfirmation(
  command: Command,
  flags: Record<string, string | true>
): boolean {
  if (command.mutating) return true;
  // `raw` is read-only by default but can POST, and DSM treats POST as mutating.
  return command.name === "raw" && (flags.post === true || flags.post === "true");
}

/**
 * Resolve argv against the registry, longest command path first so "packages
 * install" wins over a hypothetical "packages". Returns the command plus the
 * positional arguments left over.
 */
export function resolveCommand(
  argv: string[]
): { command: Command; args: string[] } | null {
  const byLength = [...COMMANDS].sort(
    (a, b) => b.name.split(" ").length - a.name.split(" ").length
  );
  for (const command of byLength) {
    const parts = command.name.split(" ");
    if (parts.every((p, i) => argv[i] === p)) {
      return { command, args: argv.slice(parts.length) };
    }
  }
  return null;
}
