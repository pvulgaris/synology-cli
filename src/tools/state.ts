/**
 * Declared state for a backup destination: compare a NAS with an expected-state
 * file and, on apply, converge the fields with a verified write path.
 *
 * Checks read the same calls apply writes, captured from the DSM 7.4.1 UI on
 * 2026-09-28:
 *
 * SYNO.Core.Share.Permission list/set v1: { name, user_group_type, permissions }.
 * SYNO.Core.Share.Snapshot get_schedule/set_schedule v1 (v2 answers 103):
 *   set_schedule takes the task_id and schedule object that get_schedule
 *   returned, plus enable_snapshot_schedule. A task_id of -1 (no task yet)
 *   makes the NAS create one. get_schedule accepts the name quoted or bare.
 * SYNO.DisasterRecovery.Retention get/set v1: the Smart Recycle policy. get
 *   carries each tier count twice (advDaily and daily); set accepts the record
 *   get returns (policyType 128 = Smart Retention). DSM stores the adv* copy:
 *   a live set of advYearly=1 with yearly=1 read back advYearly 1, yearly 0.
 * SYNO.DisasterRecovery.Retention get_worm_lock/set_worm_lock v1:
 *   { type: "Share", name, worm_lock_enable, worm_lock_day }.
 * SYNO.Core.FileServ.NFS.SharePrivilege load/save v1, driven with `syno raw`
 *   and read back on 2026-09-29: both take `share_name` (`name` answers 2301,
 *   and a share that does not exist answers 2370); save replaces the share's
 *   whole rule set; each rule is { client, privilege, root_squash, async,
 *   insecure, crossmnt, security_flavor: { kerberos, kerberos_integrity,
 *   kerberos_privacy, sys } }.
 * SYNO.Core.Region.NTP get/set v1, set sent with `syno raw` and read back on
 *   2026-09-30: { timezone, enable_ntp, server }. Zones are DSM's own names
 *   ("Eastern", "Pacific"), not IANA; enable_ntp reads "ntp" when NTP is on.
 * SYNO.Core.FileServ.NFS get v1: { enable_nfs, ... }. `root_squash` names who is mapped to what: "root" means no
 *   mapping, "admin"/"guest" map root only, and "all_admin"/"all_guest" map
 *   every user. An unknown value answers 2301. DSM stores `client` exactly as
 *   sent, rejects a rule missing a field, and accepts two rules for one client.
 *
 * The share and the account are never created here: DSM's create dialogs are
 * the honest path for two things that happen once per NAS.
 */

import type { RuntimeConfig } from "../config.js";
import { errorMessage, type SynoClient } from "../client.js";
import { withAudit } from "../audit.js";
import { nasSharesList } from "./shares.js";
import { nasUsersList } from "./security.js";

const TIERS = ["hourly", "daily", "weekly", "monthly", "yearly"] as const;
type Counts = Record<(typeof TIERS)[number], number>;

export interface ExpectedState {
  time?: { timezone: string; ntp_server: string };
  share: {
    name: string;
    vol_path?: string;
    btrfs_cow?: boolean;
    recycle_bin?: boolean;
    encryption?: number;
    support_snapshot?: boolean;
  };
  account?: {
    name: string;
    description?: string;
    password_never_expire?: boolean;
  };
  snapshots?: {
    enabled: boolean;
    time: string;
    week_days: number[];
    // DSM's own schedule fields; the encoding is in docs/dsm-api-quirks.md.
    repeat: number;
    repeat_hour: number;
    repeat_min: number;
    last_work_hour: number;
    smart_recycle?: Counts;
    immutable_days?: number;
  };
  /** The share's complete NFS export rule set; `[]` declares "not exported". */
  nfs?: { rules: NfsRule[] };
}

// All five saved and read back on DSM 7.4.1; "root_squash" and "map_root" answer 2301.
const SQUASH = ["root", "admin", "guest", "all_admin", "all_guest"] as const;
interface NfsRule {
  client: string;
  privilege: "rw" | "ro";
  root_squash: (typeof SQUASH)[number];
  async: boolean;
  insecure: boolean;
  crossmnt: boolean;
}
const NFS_RULE_KEYS = ["client", "privilege", "root_squash", "async", "insecure", "crossmnt"] as const;
// The only security flavor this file writes, and so the only one a check accepts.
const SYS_ONLY = { kerberos: false, kerberos_integrity: false, kerberos_privacy: false, sys: true };

export interface Finding {
  subject: string;
  message: string;
  /** "api": converged by apply; "dsm": needs the DSM UI. */
  fix: "api" | "dsm";
  /** The setter apply runs; a function, so JSON output omits it. */
  set?: () => Promise<unknown>;
  /** Set by apply when the setter threw. */
  error?: string;
  /** What the setter overwrites wholesale, kept so the audit can rebuild it. */
  previous?: unknown;
}

// A misspelled key would silently skip its check and report a clean NAS, so
// the file is validated strictly: unknown keys and wrong types are errors.
type Kind = "string" | "boolean" | "count" | "time" | "days" | "counts" | "nfs_rules";
const FIELDS: Record<string, Record<string, Kind>> = {
  time: { timezone: "string", ntp_server: "string" },
  share: {
    name: "string",
    vol_path: "string",
    btrfs_cow: "boolean",
    recycle_bin: "boolean",
    encryption: "count",
    support_snapshot: "boolean",
  },
  account: { name: "string", description: "string", password_never_expire: "boolean" },
  snapshots: {
    enabled: "boolean",
    time: "time",
    week_days: "days",
    repeat: "count",
    repeat_hour: "count",
    repeat_min: "count",
    last_work_hour: "count",
    smart_recycle: "counts",
    immutable_days: "count",
  },
  nfs: { rules: "nfs_rules" },
};
const REQUIRED: Record<string, string[]> = {
  time: ["timezone", "ntp_server"],
  share: ["name"],
  account: ["name"],
  snapshots: ["enabled", "time", "week_days", "repeat", "repeat_hour", "repeat_min", "last_work_hour"],
  nfs: ["rules"],
};
const isCount = (v: unknown) => Number.isInteger(v) && (v as number) >= 0;
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const VALID: Record<Kind, [string, (v: unknown) => boolean]> = {
  string: ["a string", (v) => typeof v === "string" && v !== ""],
  boolean: ["true or false", (v) => typeof v === "boolean"],
  count: ["a non-negative integer", isCount],
  time: ['"HH:MM"', (v) => typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v)],
  days: [
    "distinct weekdays 0-6",
    (v) => Array.isArray(v) && new Set(v).size === v.length && v.every((d) => isCount(d) && d <= 6),
  ],
  counts: [
    `{ ${TIERS.join(", ")} } counts`,
    (v) => isObject(v) && Object.keys(v).length === TIERS.length && TIERS.every((t) => isCount(v[t])),
  ],
  nfs_rules: [
    `rules with exactly ${NFS_RULE_KEYS.join(", ")}, one per client; privilege "rw" or "ro"; root_squash one of ${SQUASH.join(", ")}`,
    (v) =>
      Array.isArray(v) &&
      new Set(v.map((r) => (isObject(r) ? r.client : undefined))).size === v.length &&
      v.every(
        (r) =>
          isObject(r) &&
          Object.keys(r).length === NFS_RULE_KEYS.length &&
          typeof r.client === "string" &&
          /^\S+$/.test(r.client) &&
          (r.privilege === "rw" || r.privilege === "ro") &&
          (SQUASH as readonly unknown[]).includes(r.root_squash) &&
          typeof r.async === "boolean" &&
          typeof r.insecure === "boolean" &&
          typeof r.crossmnt === "boolean"
      ),
  ],
};

export function parseExpectedState(text: string): ExpectedState {
  const parsed = JSON.parse(text);
  if (!isObject(parsed)) throw new Error("expected a JSON object");
  if (parsed.share === undefined) throw new Error("share is required");
  for (const [section, value] of Object.entries(parsed)) {
    const fields = FIELDS[section];
    if (!fields) throw new Error(`unknown key ${section}`);
    if (!isObject(value)) throw new Error(`${section} must be an object`);
    for (const key of REQUIRED[section]) {
      if (value[key] === undefined) throw new Error(`${section}.${key} is required`);
    }
    for (const [key, v] of Object.entries(value)) {
      if (!fields[key]) throw new Error(`unknown key ${section}.${key}`);
      const [expected, valid] = VALID[fields[key]];
      if (!valid(v)) throw new Error(`${section}.${key} must be ${expected}`);
    }
  }
  return parsed as unknown as ExpectedState;
}

// DSM JSON-parses each form value: numbers and booleans go as-is, strings and
// objects JSON-encoded.
const q = JSON.stringify;
const wire = (v: unknown) => (typeof v === "number" || typeof v === "boolean" ? v : q(v));
const adv = (tier: string) => `adv${tier[0].toUpperCase()}${tier.slice(1)}`;
const weekName = (days: number[]) => [...days].sort((a, b) => a - b).join(",");

async function evaluate(dsm: SynoClient, expected: ExpectedState): Promise<Finding[]> {
  const findings: Finding[] = [];
  const drift = (subject: string, message: string, set?: Finding["set"], previous?: unknown) => {
    findings.push({ subject, message, fix: set ? "api" : "dsm", set, ...(previous === undefined ? {} : { previous }) });
  };

  const time = expected.time;
  if (time) {
    const current = await dsm.call({ api: "SYNO.Core.Region.NTP", method: "get", version: 1 });
    const want: Record<string, unknown> = { timezone: time.timezone, enable_ntp: "ntp", server: time.ntp_server };
    const off = Object.keys(want).filter((k) => current[k] !== want[k]);
    if (off.length) {
      // All three go together: a partial set is reported to be rejected.
      drift("time", off.map((k) => `${k} is ${JSON.stringify(current[k])}, expected ${JSON.stringify(want[k])}`).join(", "), () =>
        dsm.call({
          api: "SYNO.Core.Region.NTP",
          method: "set",
          version: 1,
          post: true,
          params: Object.fromEntries(Object.entries(want).map(([k, v]) => [k, q(v)])),
        })
      );
    }
  }

  const share = expected.share;
  const shares = (await nasSharesList(dsm)).shares as Array<Record<string, unknown>>;
  const live = shares.find((s) => s.name === share.name);
  if (!live) {
    drift("share", `${share.name} does not exist`);
    return findings;
  }
  for (const [key, want] of Object.entries(share)) {
    if (key !== "name" && live[key] !== want) {
      drift("share", `${key} is ${JSON.stringify(live[key])}, expected ${JSON.stringify(want)}`);
    }
  }

  const account = expected.account;
  if (account) {
    const users = (await nasUsersList(dsm)).users as Array<Record<string, unknown>>;
    const user = users.find((u) => u.name === account.name);
    if (!user) {
      drift("account", `${account.name} does not exist`);
    } else {
      for (const [key, want] of Object.entries(account)) {
        if (key !== "name" && user[key] !== want) {
          drift("account", `${key} is ${JSON.stringify(user[key])}, expected ${JSON.stringify(want)}`);
        }
      }
      const permissions = await dsm.call({
        api: "SYNO.Core.Share.Permission",
        method: "list",
        version: 1,
        params: { name: q(share.name), user_group_type: q("local_user"), with_inherit: true, limit: -1 },
      });
      const entry = (permissions?.items ?? []).find((p: any) => p.name === account.name) ?? {};
      if (entry.is_admin) drift("account", "is a NAS administrator");
      // DSM applies the strongest grant, so write access through a group beats
      // the account's own read-only row. `inherit` reads "-" or "rw" live.
      if (String(entry.inherit ?? "").includes("w")) {
        drift("permission", `${account.name} inherits write access to ${share.name} from a group`);
      }
      if (!(entry.is_readonly && !entry.is_writable && !entry.is_deny)) {
        // The share grant is read-only; repository directories get their own
        // write ACLs outside this tool.
        drift("permission", `${account.name} on ${share.name} is not read-only`, () =>
          dsm.call({
            api: "SYNO.Core.Share.Permission",
            method: "set",
            version: 1,
            post: true,
            params: {
              name: q(share.name),
              user_group_type: q("local_user"),
              permissions: q([
                { name: account.name, is_readonly: true, is_writable: false, is_deny: false },
              ]),
            },
          })
        );
      }
    }
  }

  const snapshots = expected.snapshots;
  if (snapshots && !live.support_snapshot) {
    drift("snapshots", `${share.name} does not support snapshots`);
  } else if (snapshots) {
    const shareParams = { type: q("Share"), name: q(share.name) };

    const current = await dsm.call({
      api: "SYNO.Core.Share.Snapshot",
      method: "get_schedule",
      version: 1,
      params: { name: q(share.name) },
    });
    const [hour, min] = snapshots.time.split(":").map(Number);
    const want: Record<string, unknown> = {
      hour,
      min,
      week_name: weekName(snapshots.week_days),
      repeat: snapshots.repeat,
      repeat_hour: snapshots.repeat_hour,
      repeat_min: snapshots.repeat_min,
      last_work_hour: snapshots.last_work_hour,
    };
    const have: Record<string, unknown> = {
      ...current.schedule,
      enabled: current.enable_snapshot_schedule,
      week_name: weekName(String(current.schedule?.week_name ?? "").split(",").filter(Boolean).map(Number)),
    };
    const declared: Record<string, unknown> = { enabled: snapshots.enabled, ...want };
    const off = Object.keys(declared).filter((k) => have[k] !== declared[k]);
    if (off.length) {
      drift("snapshots", `schedule ${off.map((k) => `${k} is ${JSON.stringify(have[k])}`).join(", ")}`, () =>
        dsm.call({
          api: "SYNO.Core.Share.Snapshot",
          method: "set_schedule",
          version: 1,
          post: true,
          params: {
            name: q(share.name),
            task_id: current.task_id,
            enable_snapshot_schedule: snapshots.enabled,
            schedule: q({ ...current.schedule, ...want }),
          },
        })
      );
    }

    const counts = snapshots.smart_recycle;
    if (counts) {
      const retention = await dsm.call({
        api: "SYNO.DisasterRecovery.Retention",
        method: "get",
        version: 1,
        params: shareParams,
      });
      const off = TIERS.filter((t) => retention[adv(t)] !== counts[t]);
      if (retention.policyType !== 128 || off.length) {
        drift(
          "snapshots",
          `retention policyType ${retention.policyType}${off.map((t) => `, ${t} ${retention[adv(t)]}`).join("")}; expected Smart Retention ${JSON.stringify(counts)}`,
          () => {
            // DSM stores the adv* copy. The plain copy is written too, as in the
            // verified live change; get's stale value there is never sent.
            const record: Record<string, unknown> = { ...retention, policyType: 128, type: "Share" };
            for (const t of TIERS) record[t] = record[adv(t)] = counts[t];
            const params = Object.fromEntries(Object.entries(record).map(([k, v]) => [k, wire(v)]));
            return dsm.call({ api: "SYNO.DisasterRecovery.Retention", method: "set", version: 1, post: true, params });
          }
        );
      }
    }

    const immutable = snapshots.immutable_days;
    if (immutable != null) {
      const worm = await dsm.call({
        api: "SYNO.DisasterRecovery.Retention",
        method: "get_worm_lock",
        version: 1,
        params: shareParams,
      });
      const days = worm?.worm_lock_enable ? worm.worm_lock_day : 0;
      if (days !== immutable) {
        drift("snapshots", `immutable for ${days} days, expected ${immutable}`, () =>
          dsm.call({
            api: "SYNO.DisasterRecovery.Retention",
            method: "set_worm_lock",
            version: 1,
            post: true,
            params: { ...shareParams, worm_lock_enable: immutable > 0, worm_lock_day: immutable },
          })
        );
      }
    }
  }

  const nfs = expected.nfs;
  if (nfs) {
    const loaded = await dsm.call({
      api: "SYNO.Core.FileServ.NFS.SharePrivilege",
      method: "load",
      version: 1,
      params: { share_name: q(share.name) },
    });
    // A missing list would read as "not exported" and pass a declared [].
    if (!Array.isArray(loaded?.rule)) throw new Error(`NFS rules for ${share.name} came back without a rule list`);
    const liveList: Array<Record<string, any>> = loaded.rule;
    const liveRules = new Map(liveList.map((r) => [r.client, r]));
    const clients = new Set(nfs.rules.map((r) => r.client));
    const changes: string[] = [...liveRules.keys()].filter((c) => !clients.has(c)).map((c) => `${c} not declared`);
    // The map keeps one rule per client, so count the rest here; a file never
    // declares a client twice.
    const counts = new Map<string, number>();
    for (const r of liveList) counts.set(r.client, (counts.get(r.client) ?? 0) + 1);
    for (const [client, n] of counts) if (n > 1) changes.push(`${client} has ${n} rules`);
    for (const rule of nfs.rules) {
      const have = liveRules.get(rule.client);
      if (!have) changes.push(`${rule.client} missing`);
      else for (const key of NFS_RULE_KEYS) {
        if (have[key] !== rule[key]) changes.push(`${rule.client} ${key} is ${JSON.stringify(have[key])}`);
      }
    }
    // save writes sys only, so a rule using Kerberos would be silently weakened:
    // report it and leave every rule change on this share to DSM.
    const secured = liveList
      .filter((r) => !Object.entries(SYS_ONLY).every(([k, v]) => r.security_flavor?.[k] === v))
      .map((r) => r.client);
    for (const client of secured) changes.push(`${client} uses a security flavor other than sys`);
    if (changes.length) {
      const save = () =>
        dsm.call({
          api: "SYNO.Core.FileServ.NFS.SharePrivilege",
          method: "save",
          version: 1,
          post: true,
          params: {
            share_name: q(share.name),
            rule: q(nfs.rules.map((r) => ({ ...r, security_flavor: SYS_ONLY }))),
          },
        });
      drift("nfs", `export rules: ${changes.join(", ")}`, secured.length ? undefined : save, liveList);
    }
    // Rules can match while every mount fails because the service is off.
    if (nfs.rules.length) {
      const service = await dsm.call({ api: "SYNO.Core.FileServ.NFS", method: "get", version: 1 });
      if (!service?.enable_nfs) drift("nfs", "the NFS service is off; turn it on in DSM");
    }
  }

  return findings;
}

export async function nasStateCheck(dsm: SynoClient, expected: ExpectedState) {
  const findings = await evaluate(dsm, expected);
  return { ok: findings.length === 0, findings };
}

export async function nasStateApply(runtime: RuntimeConfig, dsm: SynoClient, expected: ExpectedState) {
  const before = await evaluate(dsm, expected);
  const result = await withAudit(
    runtime,
    { tool: "state apply", args: { share: expected.share.name }, before },
    async (ctx) => {
      // One failed setter must not skip the rest.
      const writes: Finding[] = [];
      for (const f of before.filter((f) => f.set)) {
        const error = await f.set!().then(() => undefined, (err) => errorMessage(err));
        writes.push({ ...f, error });
      }
      // Recorded before the re-read, so the audit still names the writes if
      // the re-read fails.
      ctx.writes = writes;
      // A setter can drop the connection after DSM applied it, or return
      // without taking effect, so the verdict comes from a fresh read.
      const findings = await evaluate(dsm, expected);
      const errors = writes.filter((f) => f.error).map((f) => `${f.subject}: ${f.error}`);
      return {
        after: { writes, findings },
        ok: findings.length === 0,
        error: errors.length ? errors.join("; ") : undefined,
      };
    }
  );
  return { ok: result.ok, ...(result.after as { writes: Finding[]; findings: Finding[] }) };
}
