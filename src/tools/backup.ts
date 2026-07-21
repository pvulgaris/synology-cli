/**
 * Backup-audit read tools: Hyper Backup tasks and Btrfs share snapshots.
 *
 * Both are read-only. All shapes below are confirmed against a live DSM 7.3:
 *
 * SYNO.Backup.Task list v1  → { task_list: [{ task_id, name, target_id,
 *   target_type, transfer_type, data_enc, state, status, ... }] }. A Synology C2
 *   destination reports target_type "cloud_image" + transfer_type
 *   "synocloud_swift" (there is no dedicated C2 API — this is the signal).
 * SYNO.Backup.Task status v1 (+ additional[]) → { last_bkp_result, last_bkp_time,
 *   last_bkp_end_time, last_bkp_success_time, next_bkp_time, is_modified,
 *   last_bkp_error, last_bkp_error_code, schedule: { schedule: { hour, min,
 *   next_trigger_time, ... } } }. The recurring schedule IS exposed here (nested
 *   schedule.schedule), so no HAR capture is needed to read the run time.
 * SYNO.Core.Share.Snapshot list v2 (+ additional[]) → { total, snapshots: [{ time,
 *   lock, worm_lock, worm_lock_day, worm_lock_end, schedule_snapshot, desc }] }.
 *   `time` is a "GMT<±HH>-YYYY.MM.DD-HH.MM.SS" string; worm_lock is the immutable
 *   (WORM) flag. The snapshot times reveal the effective schedule; the declarative
 *   snapshot-schedule config is not exposed by this API.
 */

import { DsmError, type SynoClient } from "../dsm.js";

// Synology C2 reports target_type "cloud_image" AND transfer_type "synocloud_swift"
// (confirmed live). Requiring both avoids over-flagging any other cloud-image target.
function isC2(t: any): boolean {
  return t?.target_type === "cloud_image" && t?.transfer_type === "synocloud_swift";
}
// last_bkp_result values that mean the last COMPLETED backup succeeded. In-progress
// states (backingup/version_deleting) live in the separate `status` field, not here.
const OK_RESULTS = new Set(["done", "success"]);

// Snapshot `time` = "GMT-07-2026.07.08-00.00.01" → ISO 8601 with the offset.
function parseSnapTime(s: unknown): string | undefined {
  if (typeof s !== "string") return undefined;
  const m = s.match(/^GMT([+-]\d{2})-(\d{4})\.(\d{2})\.(\d{2})-(\d{2})\.(\d{2})\.(\d{2})$/);
  if (!m) return undefined;
  const [, off, y, mo, d, h, mi, se] = m;
  return `${y}-${mo}-${d}T${h}:${mi}:${se}${off}:00`;
}

function epochToIso(v: unknown): string | undefined {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const d = new Date(n * 1000);
  // new Date() of an out-of-range finite value is an Invalid Date; toISOString()
  // would throw RangeError — guard so one bad field can't fail the whole tool.
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function finiteNum(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export async function nasHyperbackupTasks(dsm: SynoClient) {
  // Hyper Backup registers SYNO.Backup.Task; without the package installed the
  // API is absent and DSM answers 102/103. Degrade to an honest empty result with
  // a note rather than a hard failure, matching the router-packages pattern, so a
  // NAS that backs up by other means (Cloud Sync, C2 via a different path) still
  // returns cleanly. A real auth/network error still propagates.
  let list: any;
  try {
    list = await dsm.call({ api: "SYNO.Backup.Task", method: "list", version: 1 });
  } catch (err) {
    if (err instanceof DsmError && [102, 103].includes(err.code)) {
      return { tasks: [], note: "Hyper Backup is not installed (SYNO.Backup.Task API absent)." };
    }
    throw err;
  }
  const tasks: any[] = list?.task_list ?? [];

  const out = await Promise.all(
    tasks.map(async (t) => {
      // Per-task status is optional — degrade to config-only rather than failing
      // the whole tool if one task's status read errors. Track the error so a
      // failed status read is distinguishable from a task that has never run.
      let statusError = false;
      const st = await dsm
        .call({
          api: "SYNO.Backup.Task",
          method: "status",
          version: 1,
          params: {
            task_id: t.task_id,
            additional:
              '["last_bkp_time","last_bkp_end_time","last_bkp_success_time","next_bkp_time","last_bkp_result","is_modified","last_bkp_progress"]',
          },
        })
        .catch(() => {
          statusError = true;
          return null;
        });

      const sched = st?.schedule?.schedule;
      const result: string | undefined = st?.last_bkp_result;
      const hour = sched?.hour;
      const min = sched?.min;

      return {
        task_id: t.task_id,
        name: t.name,
        destination: t.target_id,
        destination_type: t.target_type,
        transfer_type: t.transfer_type,
        is_c2: isC2(t),
        client_side_encrypted: Boolean(t.data_enc),
        state: t.state,
        status: t.status,
        status_available: !statusError,
        last_result: result ?? null,
        last_backup_ok: result == null ? null : OK_RESULTS.has(result),
        last_error: st?.last_bkp_error || undefined,
        last_error_code: st?.last_bkp_error_code || undefined,
        last_backup_time: st?.last_bkp_time,
        last_success_time: st?.last_bkp_success_time,
        last_end_time: st?.last_bkp_end_time,
        next_backup_time: st?.next_bkp_time,
        schedule:
          hour != null && min != null
            ? {
                time: `${String(hour).padStart(2, "0")}:${String(min).padStart(2, "0")}`,
                hour,
                minute: min,
                next_trigger: sched?.next_trigger_time,
              }
            : null,
        modified_since_last_backup: st?.is_modified,
      };
    }),
  );

  return { tasks: out };
}

/** Parse DSM's `week_name` ("0,1,2,3,4,5,6", Sunday=0) into an int array. */
function parseWeekDays(week: unknown): number[] {
  if (typeof week !== "string" || !week) return [];
  return week
    .split(",")
    .map((d) => Number(d))
    .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
}

/**
 * Snapshot TASK config for a share: the schedule (when snapshots are taken) and
 * the retention policy (how long they're kept). Distinct from `nasShareSnapshots`,
 * which lists the snapshots themselves.
 *
 * Source is `SYNO.Core.Share get` with `additional=["snapshot_info"]`, not the
 * Snapshot or Snapshot Replication APIs: `SYNO.Core.Share.Snapshot` only lists
 * snapshots (its config methods 103), and the Btrfs.Replica / Replica.Share APIs
 * are replication, not local-snapshot config (verified 2026-07). There is no
 * task-level immutability field here; per-snapshot WORM lock state comes from
 * `nasShareSnapshots`, so this returns a pointer rather than a lock flag.
 */
export async function nasShareSnapshotConfig(dsm: SynoClient, args: { share: string }) {
  const data = await dsm.call({
    api: "SYNO.Core.Share",
    method: "get",
    version: 1,
    params: { name: args.share, additional: '["snapshot_info"]' },
  });

  const info = data?.snapshot_info;
  if (!info) {
    // A share without Btrfs snapshot support has no snapshot_info at all.
    return {
      share: args.share,
      snapshot_capable: false,
      note: "No snapshot config — the share does not support Btrfs snapshots.",
    };
  }

  const sched = info.schedule ?? {};
  const ret = info.retention ?? {};
  const hour = sched.hour;
  const min = sched.min;

  return {
    share: args.share,
    snapshot_capable: true,
    schedule: {
      // next_trigger_time is DSM's own "this schedule will run again" signal, so
      // its presence is the reliable enabled flag — there is no separate boolean.
      enabled: Boolean(sched.next_trigger_time),
      time:
        hour != null && min != null
          ? `${String(hour).padStart(2, "0")}:${String(min).padStart(2, "0")}`
          : null,
      week_days: parseWeekDays(sched.week_name),
      next_run: sched.next_trigger_time || null,
    },
    retention: {
      // The adv* fields are the Smart Recycle (Grandfather-Father-Son) tier counts.
      smart_recycle: {
        hourly: finiteNum(ret.advHourly),
        daily: finiteNum(ret.advDaily),
        weekly: finiteNum(ret.advWeekly),
        monthly: finiteNum(ret.advMonthly),
        yearly: finiteNum(ret.advYearly),
      },
      retain_days: finiteNum(ret.retainDay),
      // policyType is DSM's raw retention-mode code; passed through rather than
      // decoded, since the mapping isn't documented and mislabeling a retention
      // mode in an audit is worse than leaving it raw. Read it in the DSM UI to
      // confirm the mode.
      policy_type: finiteNum(ret.policyType),
    },
    snapshot_count: (info.snapshots ?? []).length,
    note: "Per-snapshot immutability (WORM lock) is reported by `syno shares snapshots <share>`, not here.",
  };
}

export async function nasShareSnapshots(dsm: SynoClient, args: { share: string }) {
  const data = await dsm.call({
    api: "SYNO.Core.Share.Snapshot",
    method: "list",
    version: 2,
    params: {
      name: args.share,
      additional: '["desc","lock","worm_lock","schedule_snapshot"]',
    },
  });

  const snapshots = (data?.snapshots ?? []).map((s: any) => ({
    time: parseSnapTime(s.time) ?? s.time,
    raw_time: s.time,
    scheduled: Boolean(s.schedule_snapshot),
    user_locked: Boolean(s.lock),
    immutable: Boolean(s.worm_lock),
    immutable_days: finiteNum(s.worm_lock_day),
    immutable_until: epochToIso(s.worm_lock_end),
    description: s.desc || undefined,
  }));

  // Order chronologically by actual instant — Date.parse honours the timezone
  // offset, whereas a lexical sort of ISO strings misorders across differing
  // offsets (e.g. a DST change). Unparseable times drop out of newest/oldest.
  const dated = snapshots
    .map((s: any) => ({ iso: s.time as string, ms: Date.parse(s.time) }))
    .filter((x: { ms: number }) => Number.isFinite(x.ms))
    .sort((a: { ms: number }, b: { ms: number }) => a.ms - b.ms);

  return {
    share: args.share,
    total: data?.total ?? snapshots.length,
    immutable_count: snapshots.filter((s: any) => s.immutable).length,
    newest: dated.length ? dated[dated.length - 1].iso : undefined,
    oldest: dated.length ? dated[0].iso : undefined,
    snapshots,
  };
}
