/**
 * DSM Task Scheduler read tool.
 *
 * SYNO.Core.TaskScheduler list v3 → { total, tasks: [{ id, name, type, owner,
 *   real_owner, enable, action, next_trigger_time, can_run/edit/delete }] }.
 * SYNO.Core.TaskScheduler get v3 (id=N) → the task detail incl. `schedule`
 *   ({ hour, minute, date_type, week_day, repeat_hour, repeat_min, ... }) and,
 *   for script tasks, `extra` ({ script, notify_enable, notify_if_error,
 *   notify_mail }). Confirmed against a live DSM 7.3.
 *
 * NOTE the field-name quirk: TaskScheduler `get` returns `minute`, while
 * SYNO.Backup.Task's embedded schedule uses `min` — read both defensively.
 * Read-only: only list + get are called.
 */

import type { SynoClient } from "../dsm.js";

const pad = (n: unknown) => String(n).padStart(2, "0");

export async function nasTaskschedulerList(dsm: SynoClient) {
  const list = await dsm.call({ api: "SYNO.Core.TaskScheduler", method: "list", version: 3 });
  const tasks: any[] = list?.tasks ?? [];

  const out = await Promise.all(
    tasks.map(async (t) => {
      // Per-task detail is optional — degrade to list fields if a get errors.
      const d = await dsm
        .call({ api: "SYNO.Core.TaskScheduler", method: "get", version: 3, params: { id: t.id } })
        .catch(() => null);
      const s = d?.schedule;
      const min = s?.minute ?? s?.min;
      const ex = d?.extra;

      return {
        id: t.id,
        name: t.name,
        type: t.type, // script | custom (built-in: backup, snapshot, …)
        owner: t.owner ?? t.real_owner,
        enabled: Boolean(t.enable),
        action: t.action,
        next_run: t.next_trigger_time,
        schedule:
          s && s.hour != null && min != null
            ? {
                time: `${pad(s.hour)}:${pad(min)}`,
                hour: s.hour,
                minute: Number(min),
                week_days: s.week_day,
                repeat_hours: s.repeat_hour || undefined,
                repeat_minutes: s.repeat_min || undefined,
              }
            : null,
        // For script tasks: whether an error emails, and where.
        email_on_error: ex ? Boolean(ex.notify_enable && ex.notify_if_error) : undefined,
        notify_mail: ex?.notify_mail || undefined,
      };
    }),
  );

  return { tasks: out };
}
