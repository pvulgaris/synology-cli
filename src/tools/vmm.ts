/**
 * Virtual Machine Manager guests: inventory and clean power control.
 *
 * These use the `SYNO.Virtualization.API.*` family. The VMM UI calls a
 * different family, `SYNO.Virtualization.Guest.*` (its power call is
 * `Guest.Action.pwr_ctl`), which also powered a guest on under VMM 2.7.
 */

import type { RuntimeConfig } from "../config.js";
import {
  SynologyApiError,
  errorMessage,
  isSoftTransportError,
  type SynoClient,
} from "../client.js";
import { withAudit } from "../audit.js";
import { poll } from "./poll.js";
import { setTimeout as sleep } from "node:timers/promises";

export interface VmGuest {
  name: string;
  /** "running" and "shutdown" are the observed steady states. Others are
   *  transitional (booting, shutting down, migrating) and count as not stopped. */
  status: string;
}

export type VmPowerAction = "poweron" | "shutdown";

const TARGET_STATUS: Record<VmPowerAction, string> = {
  poweron: "running",
  shutdown: "shutdown",
};

/** One deadline covers retrying code 600 and waiting for the target status.
 *  An ACPI shutdown depends on the guest OS; Home Assistant OS took about 30s. */
export interface VmTiming {
  intervalMs: number;
  timeoutMs: number;
}

const DEFAULT_TIMING: VmTiming = { intervalMs: 3_000, timeoutMs: 180_000 };

export async function listGuests(dsm: SynoClient): Promise<VmGuest[]> {
  const data = await dsm.call<{ guests?: any[] }>({
    api: "SYNO.Virtualization.API.Guest",
    method: "list",
    version: 1,
  });
  return (data.guests ?? []).map((g) => ({
    name: String(g.guest_name),
    status: String(g.status),
  }));
}

async function findGuest(dsm: SynoClient, name: string): Promise<VmGuest | null> {
  return (await listGuests(dsm)).find((g) => g.name === name) ?? null;
}

/**
 * Power a guest on, or shut it down through ACPI, and return once VMM reports
 * the target status. There is deliberately no hard power-off: a guest that
 * ignores ACPI belongs in the VMM UI, where someone can decide to force it.
 */
export async function nasVmGuestControl(
  cfg: RuntimeConfig,
  dsm: SynoClient,
  args: { name: string; action: VmPowerAction },
  timing: VmTiming = DEFAULT_TIMING
) {
  const before = await findGuest(dsm, args.name);
  if (!before) throw new Error(`VM guest "${args.name}" not found.`);
  const target = TARGET_STATUS[args.action];
  if (before.status === target) return { before, after: before };

  const deadline = Date.now() + timing.timeoutMs;
  const failure = `VM guest "${args.name}" did not reach "${target}" within ${
    timing.timeoutMs / 1000
  }s.`;
  const { after, ok } = await withAudit(
    cfg,
    { tool: "vms.control", args: { ...args }, before },
    async (audit) => {
      // `Guest.Action` takes one `guest_name` (or `guest_id`). Dead ends seen
      // live: `API.Guest.poweron` is 103 (the method lives on `.Action`), and
      // `API.Guest.Action.poweron` with a `guest_ids` array was refused with 401.
      //
      // Code 600 came back from `poweron` about 10s after a VMM package upgrade
      // finished, while the package already reported running; the same call
      // succeeded 20s later. Treat 600 as "VMM not ready yet" and retry.
      for (;;) {
        try {
          await dsm.call({
            api: "SYNO.Virtualization.API.Guest.Action",
            method: args.action,
            version: 1,
            post: true,
            params: { guest_name: JSON.stringify(args.name) },
          });
          break;
        } catch (err) {
          // A dropped connection can still complete on the NAS; the poll decides.
          if (isSoftTransportError(err)) {
            audit.write_error = errorMessage(err);
            break;
          }
          const notReady = err instanceof SynologyApiError && err.code === 600;
          if (!notReady || Date.now() >= deadline) throw err;
          await sleep(timing.intervalMs);
        }
      }
      const state = await poll({
        read: () => findGuest(dsm, args.name),
        done: (g) => g?.status === target,
        intervalMs: timing.intervalMs,
        timeoutMs: Math.max(0, deadline - Date.now()),
      });
      const reached = state?.status === target;
      return { after: state, ok: reached, error: reached ? undefined : failure };
    }
  );
  if (!ok) throw new Error(failure);
  return { before, after };
}
