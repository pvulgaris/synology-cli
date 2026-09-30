/**
 * Declared-state check and apply against canned DSM responses. The fake
 * records every call so the tests can assert which writes apply and that the
 * wire encoding (JSON-quoted strings, stringified objects) survives.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SynoClient, SynologyCallOptions } from "../client.js";
import { nasStateApply, nasStateCheck, parseExpectedState, type ExpectedState } from "./state.js";

const EXPECTED: ExpectedState = {
  time: { timezone: "Eastern", ntp_server: "time.google.com" },
  share: { name: "backups", vol_path: "/volume1", btrfs_cow: true, recycle_bin: false, encryption: 0 },
  account: { name: "backups", description: "Managed backup account: backups", password_never_expire: true },
  snapshots: {
    enabled: true,
    time: "04:30",
    week_days: [0, 1, 2, 3, 4, 5, 6],
    repeat: 0,
    repeat_hour: 0,
    repeat_min: 0,
    last_work_hour: 4,
    smart_recycle: { hourly: 24, daily: 7, weekly: 2, monthly: 1, yearly: 0 },
    immutable_days: 7,
  },
  nfs: {
    rules: [{ client: "192.0.2.10", privilege: "rw", root_squash: "all_admin", async: true, insecure: true, crossmnt: false }],
  },
};

const SYS_ONLY = { kerberos: false, kerberos_integrity: false, kerberos_privacy: false, sys: true };

type Responses = Record<string, any>;

/** Shapes follow the live DSM 7.4.1 responses. */
function healthy(): Responses {
  return {
    "SYNO.Core.Share.list": {
      shares: [
        { name: "backups", vol_path: "/volume1", enable_share_cow: true, enable_recycle_bin: false, encryption: 0, support_snapshot: true },
      ],
    },
    "SYNO.Core.User.list": {
      users: [{ name: "backups", description: "Managed backup account: backups", passwd_never_expire: true, expired: "normal" }],
    },
    "SYNO.Core.Share.Permission.list": {
      items: [{ name: "backups", is_admin: false, is_readonly: true, is_writable: false, is_deny: false, inherit: "-" }],
    },
    "SYNO.Core.Share.Snapshot.get_schedule": {
      enable_snapshot_schedule: true,
      task_id: 5,
      schedule: { date_type: 0, hour: 4, min: 30, week_name: "0,1,2,3,4,5,6", repeat: 0, repeat_hour: 0, repeat_min: 0, last_work_hour: 4 },
    },
    "SYNO.DisasterRecovery.Retention.get": {
      advHourly: 24, advDaily: 7, advWeekly: 2, advMonthly: 1, advYearly: 0,
      hourly: 24, daily: 7, weekly: 2, monthly: 1, yearly: 0,
      name: "backups", policyType: 128, prefix: "Share#", schedule: { hour: 2 }, tid: -1,
    },
    "SYNO.DisasterRecovery.Retention.get_worm_lock": { worm_lock_enable: true, worm_lock_day: 7 },
    "SYNO.Core.FileServ.NFS.SharePrivilege.load": {
      rule: [{ async: true, client: "192.0.2.10", crossmnt: false, insecure: true, privilege: "rw", root_squash: "all_admin", security_flavor: { ...SYS_ONLY } }],
    },
    "SYNO.Core.FileServ.NFS.SharePrivilege.save": {},
    "SYNO.Core.FileServ.NFS.get": { enable_nfs: true },
    "SYNO.Core.Share.Permission.set": {},
    "SYNO.Core.Share.Snapshot.set_schedule": {},
    "SYNO.DisasterRecovery.Retention.set": {},
    "SYNO.DisasterRecovery.Retention.set_worm_lock": {},
    "SYNO.Core.Region.NTP.get": { enable_ntp: "ntp", server: "time.google.com", timezone: "Eastern" },
    "SYNO.Core.Region.NTP.set": {},
  };
}

/** `effects` runs after a matching call, so a write can change what the re-read sees. */
function fakeClient(
  responses: Responses,
  calls: SynologyCallOptions[],
  effects: Record<string, () => void> = {}
): SynoClient {
  const call = async (opts: SynologyCallOptions): Promise<unknown> => {
    calls.push(opts);
    const key = `${opts.api}.${opts.method}`;
    if (!(key in responses)) throw new Error(`unexpected DSM call: ${key}`);
    const response = responses[key];
    if (response instanceof Error) throw response;
    effects[key]?.();
    return response;
  };
  return { call } as unknown as SynoClient;
}

const runtime = () => ({ auditLogDir: mkdtempSync(join(tmpdir(), "syno-audit-")) });
const posts = (calls: SynologyCallOptions[]) => calls.filter((c) => c.post);

test("state check: a matching NAS is ok regardless of key and weekday order", async () => {
  const calls: SynologyCallOptions[] = [];
  const reordered = {
    ...EXPECTED,
    snapshots: {
      ...EXPECTED.snapshots!,
      week_days: [6, 0, 1, 2, 3, 4, 5],
      smart_recycle: { yearly: 0, monthly: 1, weekly: 2, daily: 7, hourly: 24 },
    },
  };
  const result = await nasStateCheck(fakeClient(healthy(), calls), reordered);
  assert.deepEqual(result, { ok: true, findings: [] });
  assert.equal(posts(calls).length, 0);
});

test("state check: drift is reported per field and never applied", async () => {
  const r = healthy();
  r["SYNO.Core.Share.list"].shares[0].enable_recycle_bin = true;
  r["SYNO.Core.Share.Permission.list"].items[0].is_writable = true;
  r["SYNO.Core.Share.Permission.list"].items[0].inherit = "rw";
  r["SYNO.Core.Share.Snapshot.get_schedule"].schedule.repeat_hour = 1;
  r["SYNO.DisasterRecovery.Retention.get"].policyType = 2;
  r["SYNO.DisasterRecovery.Retention.get_worm_lock"].worm_lock_day = 8;
  const calls: SynologyCallOptions[] = [];
  const result = await nasStateCheck(fakeClient(r, calls), EXPECTED);
  assert.equal(result.ok, false);
  assert.deepEqual(
    result.findings.map((f) => [f.subject, f.fix, f.message]),
    [
      ["share", "dsm", "recycle_bin is true, expected false"],
      ["permission", "dsm", "backups inherits write access to backups from a group"],
      ["permission", "api", "backups on backups is not read-only"],
      ["snapshots", "api", "schedule repeat_hour is 1"],
      ["snapshots", "api", 'retention policyType 2; expected Smart Retention {"hourly":24,"daily":7,"weekly":2,"monthly":1,"yearly":0}'],
      ["snapshots", "api", "immutable for 8 days, expected 7"],
    ]
  );
  assert.equal(posts(calls).length, 0);
});

test("state check: NFS export drift names each rule change", async () => {
  const r = healthy();
  r["SYNO.Core.FileServ.NFS.SharePrivilege.load"].rule = [
    { async: true, client: "192.0.2.10", crossmnt: false, insecure: false, privilege: "rw", root_squash: "root", security_flavor: { ...SYS_ONLY } },
    { async: true, client: "198.51.100.7", crossmnt: false, insecure: true, privilege: "rw", root_squash: "all_admin", security_flavor: { ...SYS_ONLY } },
  ];
  const calls: SynologyCallOptions[] = [];
  const result = await nasStateCheck(fakeClient(r, calls), EXPECTED);
  assert.deepEqual(
    result.findings.map((f) => [f.subject, f.fix, f.message]),
    [
      ["nfs", "api", 'export rules: 198.51.100.7 not declared, 192.0.2.10 root_squash is "root", 192.0.2.10 insecure is false'],
    ]
  );
  assert.equal(posts(calls).length, 0);
});

test("state apply: a Kerberos export is reported for DSM, never rewritten to sys", async () => {
  const r = healthy();
  r["SYNO.Core.FileServ.NFS.SharePrivilege.load"].rule[0].security_flavor = { ...SYS_ONLY, kerberos: true };
  const expected = {
    ...EXPECTED,
    nfs: { rules: [...EXPECTED.nfs!.rules, { ...EXPECTED.nfs!.rules[0], client: "192.0.2.11" }] },
  };
  const calls: SynologyCallOptions[] = [];
  const result = await nasStateApply(runtime(), fakeClient(r, calls), expected);
  assert.deepEqual(
    result.findings.map((f) => [f.fix, f.message]),
    [["dsm", "export rules: 192.0.2.11 missing, 192.0.2.10 uses a security flavor other than sys"]]
  );
  assert.equal(posts(calls).length, 0);
});

test("state: a file without nfs never reads or writes export rules", async () => {
  const r = healthy();
  r["SYNO.Core.FileServ.NFS.SharePrivilege.load"].rule = [];
  const { nfs, ...withoutNfs } = EXPECTED;
  const calls: SynologyCallOptions[] = [];
  const result = await nasStateApply(runtime(), fakeClient(r, calls), withoutNfs);
  assert.deepEqual(result, { ok: true, writes: [], findings: [] });
  assert.ok(!calls.some((c) => c.api.startsWith("SYNO.Core.FileServ.NFS")));
});

test("state check: a rule load without a rule list is an error, not an empty export", async () => {
  const r = healthy();
  r["SYNO.Core.FileServ.NFS.SharePrivilege.load"] = {};
  await assert.rejects(nasStateCheck(fakeClient(r, []), { ...EXPECTED, nfs: { rules: [] } }), /without a rule list/);
});

test("state check: declared exports with the NFS service off need DSM", async () => {
  const r = healthy();
  r["SYNO.Core.FileServ.NFS.get"].enable_nfs = false;
  const result = await nasStateCheck(fakeClient(r, []), EXPECTED);
  assert.deepEqual(result.findings.map((f) => [f.fix, f.message]), [["dsm", "the NFS service is off; turn it on in DSM"]]);
  // With nothing exported, the service does not matter.
  const unexported = healthy();
  unexported["SYNO.Core.FileServ.NFS.SharePrivilege.load"].rule = [];
  unexported["SYNO.Core.FileServ.NFS.get"].enable_nfs = false;
  assert.equal((await nasStateCheck(fakeClient(unexported, []), { ...EXPECTED, nfs: { rules: [] } })).ok, true);
});

test("state check: a second rule for a declared client is drift", async () => {
  const r = healthy();
  const [first] = r["SYNO.Core.FileServ.NFS.SharePrivilege.load"].rule;
  r["SYNO.Core.FileServ.NFS.SharePrivilege.load"].rule = [{ ...first, privilege: "ro" }, first];
  const result = await nasStateCheck(fakeClient(r, []), EXPECTED);
  assert.deepEqual(result.findings.map((f) => f.message), ["export rules: 192.0.2.10 has 2 rules"]);
});

test("state apply: NFS rules are saved as the declared set, sys only, and [] unexports", async () => {
  const r = healthy();
  r["SYNO.Core.FileServ.NFS.SharePrivilege.load"].rule[0].root_squash = "root";
  const calls: SynologyCallOptions[] = [];
  const result = await nasStateApply(runtime(), fakeClient(r, calls), EXPECTED);
  assert.equal(calls.find((c) => c.method === "load")!.params!.share_name, '"backups"');
  // The rules the save overwrites stay in the output and the audit.
  assert.equal((result.writes[0].previous as any[])[0].root_squash, "root");
  const [save] = posts(calls);
  assert.equal(`${save.api}.${save.method}`, "SYNO.Core.FileServ.NFS.SharePrivilege.save");
  assert.equal(save.params!.share_name, '"backups"');
  assert.deepEqual(JSON.parse(save.params!.rule as string), [{ ...EXPECTED.nfs!.rules[0], security_flavor: SYS_ONLY }]);

  const unexport: SynologyCallOptions[] = [];
  await nasStateApply(runtime(), fakeClient(r, unexport), { ...EXPECTED, nfs: { rules: [] } });
  assert.deepEqual(posts(unexport).map((c) => [c.method, c.params!.rule]), [["save", "[]"]]);
});

test("state check: a share without snapshot support is one DSM finding", async () => {
  const r = healthy();
  r["SYNO.Core.Share.list"].shares[0].support_snapshot = false;
  const calls: SynologyCallOptions[] = [];
  const result = await nasStateCheck(fakeClient(r, calls), EXPECTED);
  assert.deepEqual(result.findings.map((f) => [f.subject, f.fix]), [["snapshots", "dsm"]]);
  assert.ok(!calls.some((c) => c.api !== "SYNO.Core.Share.list" && /Snapshot|Retention/.test(c.api)));
});

test("state apply: only api drift is written, with quoted wire params", async () => {
  const r = healthy();
  r["SYNO.Core.Share.list"].shares[0].enable_recycle_bin = true;
  r["SYNO.Core.Share.Snapshot.get_schedule"].enable_snapshot_schedule = false;
  r["SYNO.DisasterRecovery.Retention.get"].advDaily = 3;
  r["SYNO.DisasterRecovery.Retention.get"].daily = 3;
  r["SYNO.DisasterRecovery.Retention.get_worm_lock"].worm_lock_enable = false;
  const calls: SynologyCallOptions[] = [];
  await nasStateApply(runtime(), fakeClient(r, calls), EXPECTED);
  const writes = new Map(posts(calls).map((c) => [`${c.api}.${c.method}`, c.params as any]));
  assert.equal(writes.size, 3);
  const schedule = writes.get("SYNO.Core.Share.Snapshot.set_schedule");
  assert.equal(schedule.name, '"backups"');
  assert.equal(schedule.task_id, 5);
  assert.equal(schedule.enable_snapshot_schedule, true);
  assert.deepEqual(JSON.parse(schedule.schedule), r["SYNO.Core.Share.Snapshot.get_schedule"].schedule);
  const retention = writes.get("SYNO.DisasterRecovery.Retention.set");
  assert.deepEqual([retention.daily, retention.advDaily, retention.policyType, retention.tid], [7, 7, 128, -1]);
  assert.deepEqual([retention.type, retention.name, retention.prefix], ['"Share"', '"backups"', '"Share#"']);
  assert.equal(JSON.parse(retention.schedule).hour, 2);
  assert.deepEqual(writes.get("SYNO.DisasterRecovery.Retention.set_worm_lock"), {
    type: '"Share"', name: '"backups"', worm_lock_enable: true, worm_lock_day: 7,
  });
});

test("state apply: immutable_days 0 turns the lock off", async () => {
  const calls: SynologyCallOptions[] = [];
  const expected = { ...EXPECTED, snapshots: { ...EXPECTED.snapshots!, immutable_days: 0 } };
  await nasStateApply(runtime(), fakeClient(healthy(), calls), expected);
  assert.deepEqual(posts(calls).map((c) => [c.method, c.params!.worm_lock_enable, c.params!.worm_lock_day]), [
    ["set_worm_lock", false, 0],
  ]);
});

test("state apply: the verdict comes from a re-read, and a failed setter does not stop the rest", async () => {
  const r = healthy();
  r["SYNO.Core.Share.list"].shares[0].enable_recycle_bin = true;
  r["SYNO.Core.Share.Permission.list"].items[0].is_writable = true;
  r["SYNO.DisasterRecovery.Retention.get"].advDaily = 3;
  r["SYNO.DisasterRecovery.Retention.get_worm_lock"].worm_lock_enable = false;
  r["SYNO.Core.Share.Permission.set"] = new TypeError("fetch failed", { cause: new Error("connect EHOSTUNREACH 192.0.2.1:5001") });
  const calls: SynologyCallOptions[] = [];
  const rt = runtime();
  // Retention.set returns success without taking effect; set_worm_lock does.
  const result = await nasStateApply(
    rt,
    fakeClient(r, calls, {
      "SYNO.DisasterRecovery.Retention.set_worm_lock": () => (r["SYNO.DisasterRecovery.Retention.get_worm_lock"].worm_lock_enable = true),
    }),
    EXPECTED
  );
  assert.deepEqual(
    result.writes.map((f) => [f.subject, f.error]),
    [
      ["permission", "fetch failed: connect EHOSTUNREACH 192.0.2.1:5001"],
      ["snapshots", undefined],
      ["snapshots", undefined],
    ]
  );
  assert.equal(result.ok, false);
  // The DSM-only drift survives too: apply never counts it as fixed.
  assert.deepEqual(result.findings.map((f) => [f.subject, f.fix]), [
    ["share", "dsm"],
    ["permission", "api"],
    ["snapshots", "api"],
  ]);
  const [log] = readdirSync(rt.auditLogDir);
  const record = JSON.parse(readFileSync(join(rt.auditLogDir, log), "utf8"));
  assert.equal(record.args.writes.length, 3);
});

test("state apply: time drift is one write of all three fields, as sent live", async () => {
  const r = healthy();
  Object.assign(r["SYNO.Core.Region.NTP.get"], { timezone: "Pacific", enable_ntp: "manual", server: "pool.ntp.org" });
  const calls: SynologyCallOptions[] = [];
  const result = await nasStateApply(runtime(), fakeClient(r, calls), EXPECTED);
  assert.deepEqual(result.writes.map((f) => [f.subject, f.fix, f.message]), [
    ["time", "api", 'timezone is "Pacific", expected "Eastern", enable_ntp is "manual", expected "ntp", server is "pool.ntp.org", expected "time.google.com"'],
  ]);
  // The params `syno raw` sent on 2026-09-30, which DSM applied and read back.
  assert.deepEqual(posts(calls).map((c) => [`${c.api}.${c.method}`, c.params]), [
    ["SYNO.Core.Region.NTP.set", { timezone: '"Eastern"', enable_ntp: '"ntp"', server: '"time.google.com"' }],
  ]);
});

test("parseExpectedState rejects what would silently skip a check", () => {
  const valid = JSON.parse(JSON.stringify(EXPECTED));
  const reject = (edit: (s: any) => void, message: RegExp) => {
    const state = JSON.parse(JSON.stringify(valid));
    edit(state);
    assert.throws(() => parseExpectedState(JSON.stringify(state)), message);
  };
  assert.deepEqual(parseExpectedState(JSON.stringify(valid)), valid);
  assert.throws(() => parseExpectedState("{}"), /share is required/);
  reject((s) => ((s.snapshot = s.snapshots), delete s.snapshots), /unknown key snapshot$/);
  reject((s) => (s.snapshots.immutableDays = 7), /unknown key snapshots\.immutableDays/);
  reject((s) => (s.snapshots.immutable_days = "7"), /snapshots\.immutable_days must be a non-negative integer/);
  reject((s) => (s.snapshots.time = "4:30"), /snapshots\.time must be "HH:MM"/);
  reject((s) => delete s.snapshots.repeat_hour, /snapshots\.repeat_hour is required/);
  reject((s) => delete s.time.ntp_server, /time\.ntp_server is required/);
  reject((s) => delete s.snapshots.smart_recycle.yearly, /snapshots\.smart_recycle must be/);
  reject((s) => (s.nfs.rules[0].root_squash = "root_squash"), /nfs\.rules must be/);
  reject((s) => delete s.nfs.rules[0].insecure, /nfs\.rules must be/);
  reject((s) => s.nfs.rules.push({ ...s.nfs.rules[0] }), /nfs\.rules must be/);
  reject((s) => (s.nfs.rules[0].client = "192.0.2.10 "), /nfs\.rules must be/);
  reject((s) => delete s.nfs.rules, /nfs\.rules is required/);
});
