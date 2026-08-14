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

import type { Platform, RuntimeConfig, TargetConfig } from "./config.js";
import type { SynoClient } from "./client.js";
import {
  methodMayMutate,
  isSensitiveParamKey,
  redactSensitiveValues,
} from "./client.js";
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
import { nasDsmOsCheckUpdate } from "./tools/updates.js";
import { routerSrmOsCheckUpdate } from "./tools/srm.js";
import {
  nasHyperbackupTasks,
  nasShareSnapshots,
  nasShareSnapshotConfig,
} from "./tools/backup.js";
import { nasTaskschedulerList } from "./tools/scheduler.js";
import {
  nasContainerControl,
  nasContainerImagesList,
  nasContainerLogs,
  nasContainerProjectDeploy,
  nasContainerProjectInfo,
  nasContainerProjectsList,
  nasContainerRemove,
  nasContainersList,
} from "./tools/containers.js";
import { withAudit } from "./audit.js";

/** Raw calls observed to use write-shaped method names or POST for read-only
 * work. Keep these exceptions endpoint-specific so unknown DSM APIs retain the
 * conservative confirmation gate. */
const RAW_READ_ONLY_CALLS = new Set([
  "SYNO.Virtualization.Guest.check_availability",
  "SYNO.Virtualization.Guest.gen_mac",
  "SYNO.Virtualization.Guest.list_resource",
  "SYNO.Virtualization.Guest.read_ovf",
]);

function rawCallMayMutate(api: string, method: string, post: boolean): boolean {
  if (RAW_READ_ONLY_CALLS.has(`${api}.${method}`)) return false;
  return post || methodMayMutate(method);
}

/** A bad invocation (missing arg, unknown value, malformed param) as opposed to a
 *  runtime/API failure. The top-level catch maps this to exit 2, keeping the
 *  documented "2 on a usage error" contract instead of collapsing everything to 1. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export interface CommandContext {
  runtime: RuntimeConfig;
  target: TargetConfig;
  client: SynoClient;
  /** Positional arguments after the command path. */
  args: string[];
  /** Parsed `--flag` / `--flag=value` tokens. Bare flags are `true`. */
  flags: Record<string, string | true>;
}

export interface Command {
  /** Space-joined command path, e.g. "packages install". */
  name: string;
  summary: string;
  platforms: readonly Platform[];
  /** Required positional arguments after the command path. */
  args?: readonly string[];
  /** Optional trailing positional values, used by raw k=v parameters. */
  variadic?: string;
  flags?: Readonly<Record<string, FlagSpec>>;
  /**
   * Mutating commands require an explicit --yes because the CLI does not prompt.
   */
  mutating?: boolean;
  run(ctx: CommandContext): Promise<unknown>;
}

export type RegisteredCommand = Command;

type FlagType = "boolean" | "string" | "integer";
export type FlagSpec =
  | FlagType
  | { type: FlagType; required?: boolean; value?: string };

function flagType(spec: FlagSpec): FlagType {
  return typeof spec === "string" ? spec : spec.type;
}

function commandFlags(
  command: RegisteredCommand
): Readonly<Record<string, FlagSpec>> {
  return {
    verbose: "boolean",
    ...(command.mutating || command.name === "raw" ? { yes: "boolean" as const } : {}),
    ...(command.platforms.length > 1
      ? { target: { type: "string" as const, value: "dsm|srm" } }
      : {}),
    ...(command.flags ?? {}),
  };
}

export function commandUsage(command: RegisteredCommand): string {
  const positionals = (command.args ?? []).map((name) => `<${name}>`);
  if (command.variadic) positionals.push(`[${command.variadic} ...]`);
  const flags = Object.entries(commandFlags(command)).map(([name, spec]) => {
    const type = flagType(spec);
    const value = typeof spec === "string" ? undefined : spec.value;
    const rendered =
      type === "boolean"
        ? `--${name}`
        : `--${name}=${value ?? (type === "integer" ? "N" : "VALUE")}`;
    return typeof spec !== "string" && spec.required ? rendered : `[${rendered}]`;
  });
  return [...positionals, ...flags].join(" ");
}

/** Validation guarantees required positional arguments before dispatch. */
function arg(ctx: CommandContext, index: number): string {
  return ctx.args[index];
}

function boolFlag(ctx: CommandContext, name: string): boolean {
  const v = ctx.flags[name];
  return v === true || v === "true";
}

function strFlag(ctx: CommandContext, name: string): string | undefined {
  const v = ctx.flags[name];
  return typeof v === "string" ? v : undefined;
}

function intFlag(ctx: CommandContext, name: string): number | undefined {
  const raw = strFlag(ctx, name);
  return raw === undefined ? undefined : Number(raw);
}

const DSM = ["dsm"] as const;
const SRM = ["srm"] as const;
const SYNOLOGY = ["dsm", "srm"] as const;

export const COMMANDS: RegisteredCommand[] = [
  // ── System ────────────────────────────────────────────────────────────────
  {
    name: "status",
    summary: "DSM system status: model, version, uptime, temperature, CPU/memory load.",
    platforms: DSM,
    run: ({ client }) => nasStatus(client),
  },
  {
    name: "storage",
    summary: "Volumes (status, used/free, RAID level) and drives (S.M.A.R.T., temp, model).",
    platforms: DSM,
    run: ({ client }) => nasStorageHealth(client),
  },

  // ── Shares & snapshots ────────────────────────────────────────────────────
  {
    name: "shares list",
    summary:
      "Shared folders with encryption, quota, recycle-bin, snapshot support, BTRFS COW flag.",
    platforms: DSM,
    run: ({ client }) => nasSharesList(client),
  },
  {
    name: "shares snapshots",
    summary:
      "Btrfs snapshots for one share: timestamps, immutable/WORM lock state and window, newest/oldest, immutable count.",
    platforms: DSM,
    args: ["share"],
    run: (ctx) => nasShareSnapshots(ctx.client, { share: arg(ctx, 0) }),
  },
  {
    name: "shares snapshot-config",
    summary:
      "Snapshot task config for one share: schedule (enabled, time, days, next run) and retention (Smart Recycle counts, retain days).",
    platforms: DSM,
    args: ["share"],
    run: (ctx) => nasShareSnapshotConfig(ctx.client, { share: arg(ctx, 0) }),
  },

  // ── Backup & scheduled tasks ──────────────────────────────────────────────
  {
    name: "backup tasks",
    summary:
      "Hyper Backup tasks: destination, client-side encryption, schedule, last result, next run.",
    platforms: DSM,
    run: ({ client }) => nasHyperbackupTasks(client),
  },
  {
    name: "tasks list",
    summary: "DSM Task Scheduler entries with schedule and script notification config.",
    platforms: DSM,
    run: ({ client }) => nasTaskschedulerList(client),
  },

  // ── Container Manager ───────────────────────────────────────────────────
  {
    name: "containers list",
    summary: "Container Manager containers with image, state, health, exit code, and restart count.",
    platforms: DSM,
    run: ({ client }) => nasContainersList(client),
  },
  {
    name: "containers logs",
    summary: "Recent logs for one container in chronological order.",
    platforms: DSM,
    args: ["name"],
    flags: { limit: "integer" },
    run: (ctx) =>
      nasContainerLogs(ctx.client, {
        name: arg(ctx, 0),
        limit: intFlag(ctx, "limit"),
      }),
  },
  {
    name: "containers control",
    summary: "Start or stop one container and verify its resulting state.",
    platforms: DSM,
    args: ["name", "start|stop"],
    mutating: true,
    run: (ctx) => {
      const action = arg(ctx, 1);
      if (action !== "start" && action !== "stop") {
        throw new UsageError(`invalid action "${action}"; expected start or stop`);
      }
      return nasContainerControl(ctx.runtime, ctx.client, {
        name: arg(ctx, 0),
        action,
      });
    },
  },
  {
    name: "containers remove",
    summary: "Remove one container after it is stopped.",
    platforms: DSM,
    args: ["name"],
    mutating: true,
    run: (ctx) =>
      nasContainerRemove(ctx.runtime, ctx.client, {
        name: arg(ctx, 0),
      }),
  },
  {
    name: "containers projects list",
    summary: "Container Manager Compose projects with ids, status, and container counts.",
    platforms: DSM,
    run: ({ client }) => nasContainerProjectsList(client),
  },
  {
    name: "containers projects info",
    summary: "One Compose project's state and containers, resolved by name or id; omits Compose content.",
    platforms: DSM,
    args: ["name-or-id"],
    run: (ctx) => nasContainerProjectInfo(ctx.client, arg(ctx, 0)),
  },
  {
    name: "containers projects deploy",
    summary:
      "Stop an existing project, replace its Compose definition from a local file, build it, and verify readiness without logging the file contents.",
    platforms: DSM,
    args: ["name-or-id"],
    flags: { file: { type: "string", required: true, value: "PATH" } },
    mutating: true,
    run: (ctx) => {
      return nasContainerProjectDeploy(ctx.runtime, ctx.client, {
        project: arg(ctx, 0),
        file: strFlag(ctx, "file")!,
      });
    },
  },
  {
    name: "containers images list",
    summary: "Container Manager image inventory with repository, tags, id, size, and update flag.",
    platforms: DSM,
    run: ({ client }) => nasContainerImagesList(client),
  },

  // ── Packages ──────────────────────────────────────────────────────────────
  {
    name: "packages list",
    summary: "Installed packages with versions, running state, and is_system flag.",
    platforms: DSM,
    run: ({ client }) => nasPackagesList(client),
  },
  {
    name: "packages updates",
    summary: "Packages with pending updates from the Synology repo (excludes DSM self-update).",
    platforms: DSM,
    run: ({ client }) => nasPackagesCheckUpdates(client),
  },
  {
    name: "packages info",
    summary: "Installed and available versions plus publisher, changelog, dependencies, and size.",
    platforms: DSM,
    args: ["name"],
    run: (ctx) => nasPackageInfo(ctx.client, { name: arg(ctx, 0) }),
  },
  {
    name: "packages install",
    summary:
      "Install a package. Refuses DSM/kernel and already-installed packages. Without --accept-dependencies, a package with dependencies returns the plan instead of installing.",
    platforms: DSM,
    args: ["name"],
    flags: { "accept-dependencies": "boolean" },
    mutating: true,
    run: (ctx) =>
      nasPackageInstall(ctx.runtime, ctx.client, {
        name: arg(ctx, 0),
        accept_dependencies: boolFlag(ctx, "accept-dependencies"),
      }),
  },
  {
    name: "packages update",
    summary:
      "Update a package to the latest version. Refuses DSM/kernel and already-current packages. Verifies post-state.",
    platforms: DSM,
    args: ["name"],
    mutating: true,
    run: (ctx) => nasPackageUpdate(ctx.runtime, ctx.client, { name: arg(ctx, 0) }),
  },
  {
    name: "packages uninstall",
    summary:
      "Uninstall a package, PRESERVING its data. Requires --keep-data to proceed. Data deletion is not supported here; use the DSM UI.",
    platforms: DSM,
    args: ["name"],
    flags: { "keep-data": "boolean" },
    mutating: true,
    run: (ctx) =>
      nasPackageUninstall(ctx.runtime, ctx.client, {
        name: arg(ctx, 0),
        keep_data: boolFlag(ctx, "keep-data"),
      }),
  },
  {
    name: "packages control",
    summary: "Start/stop/restart a package. Idempotent; verifies via status poll.",
    platforms: DSM,
    args: ["name", "start|stop|restart"],
    mutating: true,
    run: (ctx) => {
      const action = arg(ctx, 1);
      if (action !== "start" && action !== "stop" && action !== "restart") {
        throw new UsageError(`invalid action "${action}"; expected start, stop, or restart`);
      }
      return nasPackageControl(ctx.runtime, ctx.client, { name: arg(ctx, 0), action });
    },
  },

  // ── Security ──────────────────────────────────────────────────────────────
  {
    name: "security scan",
    summary:
      "Run DSM Security Advisor; returns per-status check counts plus the failing rules. Polls until the async scan finishes.",
    platforms: DSM,
    run: ({ client }) => nasSecurityAdvisorScan(client),
  },
  {
    name: "security settings",
    summary:
      "DSM hardening posture: web/TLS, SSH/Telnet, SMB, NFS, auto-update, password policy, telemetry.",
    platforms: DSM,
    run: ({ client }) => nasDsmSecuritySettings(client),
  },
  {
    name: "security firewall",
    summary:
      "Firewall profiles, auto-block (failed-login lockout), and per-adapter DoS protection.",
    platforms: DSM,
    run: ({ client }) => nasFirewallList(client),
  },
  {
    name: "users list",
    summary: "DSM user accounts: name, uid, 2FA state, expired flag, email.",
    platforms: DSM,
    run: ({ client }) => nasUsersList(client),
  },
  {
    name: "external",
    summary:
      "External-facing posture: QuickConnect, DDNS, App Portal, reverse proxy, port forwarding.",
    platforms: DSM,
    run: ({ client }) => nasExternalAccess(client),
  },
  {
    name: "notifications",
    summary: "SMTP notification config: server, port, SSL, verify-cert, sender, recipient count.",
    platforms: DSM,
    run: ({ client }) => nasNotifications(client),
  },
  {
    name: "certificates",
    summary: "DSM certificates with derived days_until_expiry per cert.",
    platforms: DSM,
    run: ({ client }) => nasCertificates(client),
  },

  // ── Updates ───────────────────────────────────────────────────────────────
  {
    name: "dsm update-check",
    summary: "Whether a DSM OS update is available (read-only; does not download or apply).",
    platforms: DSM,
    run: ({ client }) => nasDsmOsCheckUpdate(client),
  },
  {
    name: "router update-check",
    summary: "Whether an SRM router OS update is available (read-only).",
    platforms: SRM,
    run: ({ client }) => routerSrmOsCheckUpdate(client),
  },

  // ── Escape hatch ──────────────────────────────────────────────────────────
  {
    name: "raw",
    summary:
      "Call any Synology Web API endpoint directly on the selected target. Accepts k=v or --params-json. GET unless --post.",
    platforms: SYNOLOGY,
    args: ["api", "method"],
    variadic: "k=v",
    flags: {
      version: { type: "integer", value: "N" },
      post: "boolean",
      "params-json": { type: "string", value: "JSON" },
    },
    run: (ctx) => {
      const api = arg(ctx, 0);
      const method = arg(ctx, 1);
      const params: Record<string, string> = {};
      const paramsJson = strFlag(ctx, "params-json");
      if (paramsJson && ctx.args.length > 2) {
        throw new UsageError("use either --params-json or trailing k=v parameters, not both");
      }
      if (paramsJson) {
        let decoded: unknown;
        try {
          decoded = JSON.parse(paramsJson);
        } catch {
          throw new UsageError("--params-json must be valid JSON");
        }
        if (!decoded || Array.isArray(decoded) || typeof decoded !== "object") {
          throw new UsageError("--params-json must contain a JSON object");
        }
        for (const [key, value] of Object.entries(decoded)) {
          params[key] = JSON.stringify(value);
        }
      }
      for (const tok of ctx.args.slice(2)) {
        const eq = tok.indexOf("=");
        if (eq < 0) {
          throw new UsageError(`unparsable param "${tok}"; expected k=v`);
        }
        params[tok.slice(0, eq)] = tok.slice(eq + 1);
      }
      const version = intFlag(ctx, "version") ?? 1;
      const post = boolFlag(ctx, "post");
      const sensitiveResponse =
        Object.keys(params).some(isSensitiveParamKey) ||
        (api === "SYNO.Docker.Project" && ["create", "get", "update"].includes(method));
      const call = () =>
        ctx.client.call({ api, method, version, post, params, sensitiveResponse });
      // DSM has mutating endpoints that use GET and read-only endpoints that
      // use POST, so the API, method, and transport jointly decide whether this
      // call needs the audit trail.
      if (!rawCallMayMutate(api, method, post)) return call();
      let result: unknown;
      return withAudit(
        ctx.runtime,
        // Redact before recording: `raw` accepts arbitrary params, so a POST to
        // an auth or token endpoint could carry a password or TOTP seed. The
        // audit log persists to disk, so those must not land in it verbatim (the
        // live API trace already drops them). The redacted map still shows which
        // keys were sent.
        {
          tool: `raw:${api}.${method}`,
          args: {
            target: ctx.target.platform,
            version,
            params: redactSensitiveValues(params),
          },
          before: null,
        },
        async () => {
          result = await call();
          return { after: redactSensitiveValues(result), ok: true };
        }
      ).then(() => result);
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

/** Reject input the selected command does not declare before loading credentials. */
export function validateInvocation(
  command: RegisteredCommand,
  args: string[],
  flags: Record<string, string | true>
): void {
  const accepted = commandFlags(command);
  for (const [name, value] of Object.entries(flags)) {
    const spec = accepted[name];
    if (!spec) throw new UsageError(`unknown flag --${name} for "${command.name}"`);
    const type = flagType(spec);
    if (type === "boolean" && ![true, "true", "false"].includes(value)) {
      throw new UsageError(`--${name} must be a boolean`);
    }
    if (type !== "boolean" && typeof value !== "string") {
      throw new UsageError(`--${name} requires a value`);
    }
    if (type === "integer" && !Number.isInteger(Number(value))) {
      throw new UsageError(`--${name} must be an integer`);
    }
  }
  for (const [name, spec] of Object.entries(accepted)) {
    if (typeof spec !== "string" && spec.required && flags[name] === undefined) {
      throw new UsageError(`missing required flag --${name}=${spec.value ?? "VALUE"}`);
    }
  }

  const required = command.args?.length ?? 0;
  if (args.length < required) {
    throw new UsageError(`missing required argument <${command.args![args.length]}>`);
  }
  if (!command.variadic && args.length > required) {
    throw new UsageError(`unexpected argument "${args[required]}"`);
  }
}

export function selectPlatform(
  command: RegisteredCommand,
  flags: Record<string, string | true>
): Platform {
  const explicit = flags.target;
  if (explicit !== undefined) {
    if (explicit !== "dsm" && explicit !== "srm") {
      throw new UsageError("--target must be dsm or srm");
    }
    if (!command.platforms.includes(explicit)) {
      throw new UsageError(`"${command.name}" does not support target ${explicit}`);
    }
    return explicit;
  }
  return command.platforms.length === 1 ? command.platforms[0] : "dsm";
}

export function commandManifest() {
  return COMMANDS.map((command) => ({
    name: command.name,
    summary: command.summary,
    usage: commandUsage(command),
    platforms: command.platforms,
    mutating: command.mutating ?? false,
    args: command.args ?? [],
    variadic: command.variadic ?? null,
    flags: Object.fromEntries(
      Object.entries(commandFlags(command)).map(([name, spec]) => [
        name,
        typeof spec === "string"
          ? { type: spec, required: false }
          : { type: spec.type, required: spec.required ?? false, value: spec.value },
      ])
    ),
  }));
}

/**
 * Writes need an explicit --yes because the CLI does not prompt. Without this,
 * an agent could uninstall a package with no confirmation step.
 */
export function requiresConfirmation(
  command: RegisteredCommand,
  flags: Record<string, string | true>,
  args: string[] = []
): boolean {
  if (command.mutating) return true;
  if (command.name !== "raw") return false;
  const post = flags.post === true || flags.post === "true";
  return args[0] && args[1] ? rawCallMayMutate(args[0], args[1], post) : post;
}

/**
 * Resolve argv against the registry, longest command path first so "packages
 * install" wins over a hypothetical "packages". Returns the command plus the
 * positional arguments left over.
 */
export function resolveCommand(
  argv: string[]
): { command: RegisteredCommand; args: string[] } | null {
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
