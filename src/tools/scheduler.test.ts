/**
 * Unit coverage for the Task Scheduler read. Canned responses mirror real DSM 7.3
 * payloads (2026-07-08): list gives id/name/type/enable/next_trigger_time; get gives
 * schedule.minute (not `min`) + extra.notify_* for script tasks. Pure/deterministic.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SynoClient, DsmCallOptions } from "../dsm.js";
import { nasTaskschedulerList } from "./scheduler.js";

function fakeClient(handlers: Record<string, (opts: DsmCallOptions) => unknown>): SynoClient {
  const call = async (opts: DsmCallOptions): Promise<unknown> => {
    const key = `${opts.api}.${opts.method}`;
    const h = handlers[key];
    if (!h) throw new Error(`unexpected DSM call: ${key}`);
    return h(opts);
  };
  return { call } as unknown as SynoClient;
}

test("taskscheduler: joins list+get, formats schedule time, reads script notify config", async () => {
  const dsm = fakeClient({
    "SYNO.Core.TaskScheduler.list": (o) => {
      assert.equal(o.version, 3);
      return {
        total: 2,
        tasks: [
          { id: 5, name: "Share [backups] Snapshot", type: "custom", owner: "root", enable: true, next_trigger_time: "2026-07-09 05:00" },
          { id: 8, name: "backup-freshness", type: "script", owner: "root", enable: true, next_trigger_time: "2026-07-09 10:00" },
        ],
      };
    },
    "SYNO.Core.TaskScheduler.get": (o) => {
      assert.equal(o.version, 3);
      if (o.params?.id === 5)
        return { schedule: { hour: 5, minute: 0, week_day: "0,1,2,3,4,5,6" }, extra: null };
      return {
        schedule: { hour: 10, minute: 0, week_day: "0,1,2,3,4,5,6" },
        extra: { notify_enable: true, notify_if_error: true, notify_mail: "user@example.com", script: "check\n" },
      };
    },
  });

  const { tasks } = await nasTaskschedulerList(dsm);
  const snap = tasks.find((t) => t.id === 5)!;
  assert.equal(snap.schedule?.time, "05:00"); // confirms the 05:00 snapshot schedule
  assert.equal(snap.email_on_error, undefined); // non-script task → no notify config
  const hc = tasks.find((t) => t.id === 8)!;
  assert.equal(hc.schedule?.time, "10:00");
  assert.equal(hc.email_on_error, true);
  assert.equal(hc.notify_mail, "user@example.com");
});

test("taskscheduler: a failing get degrades to list fields, doesn't throw", async () => {
  const dsm = fakeClient({
    "SYNO.Core.TaskScheduler.list": () => ({ tasks: [{ id: 1, name: "x", type: "custom", enable: false, next_trigger_time: "n/a" }] }),
    "SYNO.Core.TaskScheduler.get": () => {
      throw new Error("boom");
    },
  });
  const { tasks } = await nasTaskschedulerList(dsm);
  assert.equal(tasks[0].schedule, null);
  assert.equal(tasks[0].enabled, false);
});
