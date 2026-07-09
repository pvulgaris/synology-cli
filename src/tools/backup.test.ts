/**
 * Unit coverage for the backup-audit reads. Canned responses mirror the real
 * DSM 7.3 payloads captured 2026-07-08 (C2 task target_type "cloud_image" +
 * transfer_type "synocloud_swift"; snapshot `time` "GMT-07-YYYY.MM.DD-HH.MM.SS"
 * with worm_lock). The fake asserts version + additional[] on the DSM-specific
 * calls so a regression to those (the fragile parts of the contract) is caught.
 * Pure/deterministic — both tools route all I/O through client.call.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SynoClient, DsmCallOptions } from "../dsm.js";
import { nasHyperbackupTasks, nasShareSnapshots } from "./backup.js";

function fakeClient(handlers: Record<string, (opts: DsmCallOptions) => unknown>): SynoClient {
  const call = async (opts: DsmCallOptions): Promise<unknown> => {
    const key = `${opts.api}.${opts.method}`;
    const h = handlers[key];
    if (!h) throw new Error(`unexpected DSM call: ${key}`);
    return h(opts);
  };
  return { call } as unknown as SynoClient;
}

test("hyperbackup: flags C2 (target+transfer), reads schedule, maps result; asserts version+additional", async () => {
  const dsm = fakeClient({
    "SYNO.Backup.Task.list": (o) => {
      assert.equal(o.version, 1);
      return {
        task_list: [
          {
            task_id: 1,
            name: "Synology C2",
            target_id: "mynas-backups.hbk",
            target_type: "cloud_image",
            transfer_type: "synocloud_swift",
            data_enc: true,
            state: "backupable",
            status: "none",
          },
        ],
        total: 1,
      };
    },
    "SYNO.Backup.Task.status": (o) => {
      assert.equal(o.version, 1);
      assert.equal(o.params?.task_id, 1);
      // the fragile bit: additional[] must carry the fields the reshape reads.
      assert.match(String(o.params?.additional), /last_bkp_result/);
      assert.match(String(o.params?.additional), /next_bkp_time/);
      return {
        last_bkp_result: "done",
        last_bkp_time: "2026/07/07 22:40:01",
        last_bkp_success_time: "2026/07/07 23:48:59",
        next_bkp_time: "2026/07/08 22:40",
        is_modified: true,
        schedule: { schedule: { hour: 22, min: 40, next_trigger_time: "2026-07-08 22:40" } },
      };
    },
  });

  const { tasks } = await nasHyperbackupTasks(dsm);
  const t = tasks[0];
  assert.equal(t.is_c2, true);
  assert.equal(t.transfer_type, "synocloud_swift");
  assert.equal(t.client_side_encrypted, true);
  assert.equal(t.last_result, "done");
  assert.equal(t.last_backup_ok, true);
  assert.equal(t.status_available, true);
  assert.equal(t.schedule?.time, "22:40");
  assert.equal(t.next_backup_time, "2026/07/08 22:40");
});

test("hyperbackup: cloud_image without synocloud_swift is NOT C2; in-progress result is not ok", async () => {
  const dsm = fakeClient({
    "SYNO.Backup.Task.list": () => ({
      task_list: [{ task_id: 3, name: "Other cloud", target_type: "cloud_image", transfer_type: "s3", data_enc: false }],
    }),
    "SYNO.Backup.Task.status": () => ({ last_bkp_result: "backingup" }),
  });
  const { tasks } = await nasHyperbackupTasks(dsm);
  assert.equal(tasks[0].is_c2, false); // transfer_type mismatch → not C2
  assert.equal(tasks[0].last_backup_ok, false); // in-progress ≠ a completed success
});

test("hyperbackup: a failing status read degrades and is marked status_available:false", async () => {
  const dsm = fakeClient({
    "SYNO.Backup.Task.list": () => ({ task_list: [{ task_id: 2, name: "Local", target_type: "local" }] }),
    "SYNO.Backup.Task.status": () => {
      throw new Error("boom");
    },
  });
  const { tasks } = await nasHyperbackupTasks(dsm);
  assert.equal(tasks[0].status_available, false); // distinguishes error from never-run
  assert.equal(tasks[0].last_result, null);
  assert.equal(tasks[0].last_backup_ok, null);
  assert.equal(tasks[0].schedule, null); // no schedule struct → null, not a throw
});

test("snapshots: version 2 + additional asserted; ISO parse, immutable count, chronological newest/oldest", async () => {
  const dsm = fakeClient({
    "SYNO.Core.Share.Snapshot.list": (o) => {
      assert.equal(o.version, 2);
      assert.equal(o.params?.name, "backups");
      assert.match(String(o.params?.additional), /worm_lock/);
      return {
        total: 3,
        snapshots: [
          { time: "GMT-07-2026.07.04-00.00.02", lock: false, worm_lock: false, schedule_snapshot: true, desc: "x" },
          {
            time: "GMT-07-2026.07.08-00.00.01",
            lock: false,
            worm_lock: true,
            worm_lock_day: "7",
            worm_lock_end: "1784098802",
            schedule_snapshot: true,
          },
          { time: "GMT-07-2026.07.06-00.00.01", lock: false, worm_lock: true, worm_lock_day: "7", schedule_snapshot: true },
        ],
      };
    },
  });

  const r = await nasShareSnapshots(dsm, { share: "backups" });
  assert.equal(r.total, 3);
  assert.equal(r.immutable_count, 2);
  assert.equal(r.newest, "2026-07-08T00:00:01-07:00");
  assert.equal(r.oldest, "2026-07-04T00:00:02-07:00");
  assert.equal(r.snapshots[1].immutable_days, 7);
  assert.equal(r.snapshots[1].immutable_until, new Date(1784098802 * 1000).toISOString());
});

test("snapshots: a malformed worm_lock_day / unparseable time doesn't throw or corrupt ordering", async () => {
  const dsm = fakeClient({
    "SYNO.Core.Share.Snapshot.list": () => ({
      total: 2,
      snapshots: [
        { time: "GMT-07-2026.07.05-00.00.00", worm_lock: true, worm_lock_day: "not-a-number" },
        { time: "GMT-07-9999.99.99-99.99.99", worm_lock: false }, // regex-shaped but not a real date
      ],
    }),
  });
  const r = await nasShareSnapshots(dsm, { share: "backups" });
  assert.equal(r.snapshots[0].immutable_days, undefined); // NaN guarded to undefined
  assert.equal(r.newest, "2026-07-05T00:00:00-07:00"); // the unparseable one drops out of ordering
  assert.equal(r.oldest, "2026-07-05T00:00:00-07:00");
});
