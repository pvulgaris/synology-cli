import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listGuests, nasVmGuestControl, type VmTiming } from "./vmm.js";
import { SynologyApiError, type SynologyCallOptions } from "../client.js";

const FAST: VmTiming = { intervalMs: 1, timeoutMs: 50 };

function auditDir() {
  return mkdtempSync(join(tmpdir(), "syno-vmm-audit-"));
}

function auditRecords(dir: string): any[] {
  return readdirSync(dir)
    .flatMap((f) => readFileSync(join(dir, f), "utf8").trim().split("\n"))
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

/** One guest whose status follows the power calls, one list read late, as a
 *  real guest takes time to boot or shut down. `actionErrors` are thrown by
 *  successive Action calls before one succeeds (0 is a dropped connection after
 *  the NAS accepted the call); `settles` false leaves the
 *  status unchanged, like a guest that ignores ACPI. */
function fakeVmm(opts: {
  status: string;
  actionErrors?: number[];
  settles?: boolean;
}) {
  let status = opts.status;
  let next: string | null = null;
  const errors = [...(opts.actionErrors ?? [])];
  const calls: SynologyCallOptions[] = [];
  const dsm = {
    call: async (o: SynologyCallOptions) => {
      calls.push(o);
      if (o.api === "SYNO.Virtualization.API.Guest" && o.method === "list") {
        const reported = status;
        if (next) [status, next] = [next, null];
        return { guests: [{ guest_id: "g-1", guest_name: "Home Assistant OS", status: reported }] };
      }
      if (o.api === "SYNO.Virtualization.API.Guest.Action") {
        const code = errors.shift();
        if (code === 0) {
          next = o.method === "poweron" ? "running" : "shutdown";
          throw new Error("fetch failed");
        }
        if (code !== undefined) {
          throw new SynologyApiError(o.api, o.method, code, undefined, `code ${code}`);
        }
        if (opts.settles !== false) next = o.method === "poweron" ? "running" : "shutdown";
        return {};
      }
      throw new Error(`unexpected DSM call: ${o.api}.${o.method}`);
    },
  } as any;
  return { dsm, calls, actions: () => calls.filter((c) => c.method !== "list") };
}

test("listGuests reads each guest's name and status", async () => {
  const { dsm } = fakeVmm({ status: "running" });
  assert.deepEqual(await listGuests(dsm), [
    { name: "Home Assistant OS", status: "running" },
  ]);
});

test("shutdown sends one quoted guest_name POST and returns once VMM reports shutdown", async () => {
  const dir = auditDir();
  const { dsm, actions } = fakeVmm({ status: "running" });
  const res = await nasVmGuestControl(
    { auditLogDir: dir } as any,
    dsm,
    { name: "Home Assistant OS", action: "shutdown" },
    FAST
  );
  assert.equal((res.after as any).status, "shutdown");
  assert.deepEqual(
    actions().map((c) => [c.method, c.post, c.params?.guest_name]),
    [["shutdown", true, '"Home Assistant OS"']]
  );
  const [rec] = auditRecords(dir);
  assert.equal(rec.tool, "vms.control");
  assert.equal(rec.ok, true);
});

test("a guest already in the target state is left alone and not audited", async () => {
  const dir = auditDir();
  const { dsm, actions } = fakeVmm({ status: "running" });
  const res = await nasVmGuestControl(
    { auditLogDir: dir } as any,
    dsm,
    { name: "Home Assistant OS", action: "poweron" },
    FAST
  );
  assert.equal(res.after, res.before);
  assert.equal(actions().length, 0);
  assert.deepEqual(readdirSync(dir), []);
});

test("poweron retries code 600 while VMM restarts, and no other code", async () => {
  const ok = fakeVmm({ status: "shutdown", actionErrors: [600, 600] });
  const res = await nasVmGuestControl(
    { auditLogDir: auditDir() } as any,
    ok.dsm,
    { name: "Home Assistant OS", action: "poweron" },
    FAST
  );
  assert.equal((res.after as any).status, "running");
  assert.equal(ok.actions().length, 3);

  const bad = fakeVmm({ status: "shutdown", actionErrors: [401] });
  await assert.rejects(
    nasVmGuestControl(
      { auditLogDir: auditDir() } as any,
      bad.dsm,
      { name: "Home Assistant OS", action: "poweron" },
      FAST
    ),
    /code 401/
  );
  assert.equal(bad.actions().length, 1);
});

test("code 600 past the retry bound fails the command", async () => {
  const { dsm } = fakeVmm({ status: "shutdown", actionErrors: Array(1000).fill(600) });
  await assert.rejects(
    nasVmGuestControl(
      { auditLogDir: auditDir() } as any,
      dsm,
      { name: "Home Assistant OS", action: "poweron" },
      FAST
    ),
    /code 600/
  );
});

test("a guest that never reaches the target state fails", async () => {
  const { dsm } = fakeVmm({ status: "running", settles: false });
  await assert.rejects(
    nasVmGuestControl(
      { auditLogDir: auditDir() } as any,
      dsm,
      { name: "Home Assistant OS", action: "shutdown" },
      FAST
    ),
    /did not reach "shutdown"/
  );
});

test("a dropped connection on the power call is verified by the poll, not failed", async () => {
  const dir = auditDir();
  const { dsm, actions } = fakeVmm({ status: "running", actionErrors: [0] });
  const res = await nasVmGuestControl(
    { auditLogDir: dir } as any,
    dsm,
    { name: "Home Assistant OS", action: "shutdown" },
    FAST
  );
  assert.equal((res.after as any).status, "shutdown");
  assert.equal(actions().length, 1);
  const [rec] = auditRecords(dir);
  assert.equal(rec.ok, true);
  assert.equal(rec.args.write_error, "fetch failed");
});
