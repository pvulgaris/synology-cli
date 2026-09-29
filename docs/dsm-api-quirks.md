# DSM 7 Web API quirks

Consolidated notes on the Synology DSM 7 Web API surface, derived from live probing and reverse-engineering work on this project. Read before adding new tools, debugging unexpected `code:` errors, or interpreting `SYNO.API.Info` output.

What belongs here: rules that apply across the API, dead ends worth not repeating, and behavior of endpoints no code uses yet. What a value or response field means for code that reads it is a comment at that line, not an entry here; when a raw note becomes a named command, move its details into the code and delete the entry.

## Error codes

DSM error codes are NOT what they sound like — verified against [N4S4/synology-api's `error_codes.py`](https://github.com/N4S4/synology-api/blob/master/synology_api/error_codes.py) and our live probing:

| Code | Actual meaning | What it looks like |
|---|---|---|
| 101 | Invalid parameter or wrong version | Call shape mostly right; bump `version` or check params |
| 103 | Method not found | API exists; method doesn't. Often a renamed method (`list` → `load`, etc.) |
| 105 | Insufficient permissions | Even admin users hit this on some endpoints (e.g. `Notification.Rule.list`) |
| 114 | **"Lost parameters"** — missing a required param (NOT "API key mismatch") |
| 117 / 119 | SID expired — `SynoClient.call()` auto-retries with fresh login |
| 120 | Invalid `additional[]` key — DSM rejects unknown field names |
| 5100 | "Unable to perform" — generic internal failure (NOT "no records to return") |
| 5102 | Invalid enum value (e.g. `type=blocked` rejected; valid values are `allow`/`deny`) |

## Request format

- **`requestFormat: "JSON"` in `SYNO.API.Info` describes the *response* format, not the request.** Always send form-encoded params (GET querystring or POST `application/x-www-form-urlencoded`). Sending a JSON body yields 101 because DSM never parses api/method/version out of it.
- **Arrays go as a single form field with JSON-stringified value** — e.g. `configs=[{"adapter":"eth0"}]` URL-encoded into one param. Pattern used by `SYNO.Core.Security.DoS.get` and others that operate per-adapter.
- **POST is required for state-changing calls.** GET often yields 503 / "fetch failed" mid-flight. Set `post: true` on `SynologyCallOptions`.
- **DSM frequently drops the TCP connection mid-execution on state changes** (`Package.Control.stop`, `Project.build`, etc.). The action still completes server-side. Catch network-level errors (`fetch failed` / `ECONNRESET` / `ETIMEDOUT` / `socket hang up`) and verify via a status-poll instead of bailing.

## Virtual Machine Manager observations

The following `SYNO.Virtualization.Guest` v1 calls were observed to return discovery data without changing persistent VMM state:

- `list_resource`
- `check_availability`
- `gen_mac`
- `read_ovf`, which requires POST and parses an OVA already present on DSM

`SYNO.Virtualization.Cluster.get_total_progress` v1 is also a read-only poll.
It reports progress for a supplied `prefix`, such as `virtualization_guest`.

## Provisional network API observations

These shapes were observed in DSM 7 Network UI traffic. They are notes for
`syno raw`, not supported named-command contracts.

### Automatic IPv6 on one interface

Read interfaces with `SYNO.Core.Network.Ethernet` v2 `list`. Each observed row
included `ifname` and an `ipv6` array. Address presence does not identify the
configured IPv6 mode, so this observation cannot safely change an interface
that already has an IPv6 address.

The UI sent `SYNO.Entry.Request` v1 `request` as a POST with this parameter
object. `syno raw --params-json` applies the required top-level wire quoting:

```json
{
  "stop_when_error": false,
  "mode": "sequential",
  "compound": [
    {
      "api": "SYNO.Core.Network.IPv6",
      "method": "set",
      "version": 1,
      "ifname": "INTERFACE",
      "type": "auto",
      "is_default_gateway": false,
      "force": true
    },
    {
      "api": "SYNO.Core.Network.IPv6.Router",
      "method": "set",
      "version": 1,
      "type": "off",
      "config": { "wan": "INTERFACE" }
    }
  ]
}
```

The observed response had `has_fail: false` and two results with
`success: true`. Re-read the Ethernet list after the write and require a
nonempty `ipv6` array on the selected interface. A transport failure is
ambiguous, so verify state instead of repeating the write.

## Response shape

The biggest footgun: where `additional[]` keys appear in the response varies by API.

| API | Response field placement |
|---|---|
| `SYNO.Core.User.list` | Flat on each user object: `u.email`, `u["2fa_status"]` |
| `SYNO.Core.Share.list` | Flat on each share object: `s.encryption`, `s.enable_recycle_bin` |
| `SYNO.Core.Package.list` | Nested under `additional`: `p.additional.status`, `p.additional.install_type` |

Always probe with `DEBUG_DSM_RESPONSES=1` and look at the raw shape before mapping fields.

## Version negotiation

Reference implementations ([N4S4/synology-api](https://github.com/N4S4/synology-api), [gaetangr/synaudit](https://github.com/gaetangr/synaudit), Home Assistant's [py-synologydsm-api](https://github.com/mib1185/py-synologydsm-api)) all query `SYNO.API.Info?query=all` once at startup and use `maxVersion` per API. This repo doesn't — every tool hardcodes the version it was developed against, because the alternative (negotiating per startup) added a cold-start round-trip and a class of "max version returns a shape this code doesn't understand" failures we'd rather catch via a HAR capture. If a future DSM bump breaks a hardcoded version, surface it as an explicit code change, not a silent floor shift.

## Form-encoding gotcha

For form-encoded params, DSM JSON-parses each value:

- Strings need quotes on the wire: `name="FileStation"` (use `JSON.stringify("FileStation")` in code)
- Bools, numbers, null: literal — `beta=false`, `version=2`, `task_id=null`
- Arrays/objects: JSON-stringified — `configs=[{"adapter":"eth0"}]`

This is why `tools/packages.ts` wraps string params in `JSON.stringify()` everywhere.

## Other reverse-engineered patterns

- **Docker image upload URL** (used by `Project.build` for tar imports): `/webapi/entry.cgi/SYNO.Docker.Image?api=SYNO.Docker.Image&method=upload&version=1` — the API name is embedded as a URL **path segment**, not just a query param. The multipart-form field carrying the file body is named `filename`. Required header: `X-SYNO-TOKEN` (mandatory on mutating `SYNO.Docker.*` and `SYNO.Core.Package.*` endpoints; without it you get code 119).
- **Image deletion is not wrapped** in a named command. The working raw form is in the `SYNO.Docker.Image` delete section below. Do not work around the gap by exposing the Docker socket through this CLI.

## Btrfs snapshot schedule and retention

`shares snapshot-config` reads the summary from `SYNO.Core.Share get` `snapshot_info`; `state` reads and
writes the pieces below. Both call sites describe the fields they use.

**The schedule is writable on `SYNO.Core.Share.Snapshot` after all.** `get_schedule`/`set_schedule`
exist at **v1 only**; v2 answers 103, which is why an earlier probe of this API concluded it had no
config methods. The retention policy and immutable window are on `SYNO.DisasterRecovery.Retention`. The
call shapes, and the retention write that must set the `adv*` counts, are in the header of
`src/tools/state.ts`, which uses them.

**How the `schedule` object encodes the interval.** Source: DSM's own Snapshot Replication client,
`/webman/3rdparty/SnapshotReplication/disaster_recovery.js` on DSM 7.4.1 (readable with a signed-in
session's `id` cookie), class `SYNO.SDS.DisasterRecovery.Snapshot.Configure.Schedule`. Two choices were
also saved in the UI and read back with `get_schedule`, and matched.

The dialog saves only `{ date_type: 0, week_name, hour, min, repeat_hour, repeat_min, last_work_hour }`
(`getScheduleData`) through `set_schedule` with `enable_snapshot_schedule` and `task_id`. It never writes
`repeat`, `date`, `monthly_week` or `next_trigger_time`, which is why `repeat` reads 0 everywhere.

| UI interval | `repeat_hour` | `repeat_min` | Notes |
| --- | --- | --- | --- |
| Once per day | 0 | 0 | "Last snapshot time" is disabled and saved equal to `hour`. |
| Every 1, 2, 3, 4, 6, 8 or 12 hours | the hours | 0 | Offered only when the start hour plus the interval is 23 or less. |
| More options: every 5, 15 or 30 minutes | 0 | the minutes | The dialog forces `min` to 0 and disables it. |

- The dialog refuses to deselect the last weekday, so it never saves an empty `week_name`.
- `last_work_hour` is chosen from the start hour stepping by the interval up to 23 (every hour for a
  minute interval), displayed as `HH:` plus the start minute, or `HH:(60 - repeat_min)` for a minute
  interval.
- When snapshots run (`GetScheduleInfo`): on each listed weekday, from `hour * 60 + min` to
  `last_work_hour * 60 + (repeat_min > 0 ? 60 - repeat_min : 0)` minutes, inclusive, every
  `repeat_hour * 60 + repeat_min` minutes, or once when both are 0. So every 15 minutes with
  `hour` 4 and `last_work_hour` 6 runs 04:00 to 06:45. The window never wraps past midnight.
- When loading (`updateScheData`) the dialog combines the two as `repeat_hour + 100 * repeat_min`, so an
  API-written value outside the lists above has no matching option in the dialog.
- Immutable snapshots: the protection period is 1 to 30 days, and the dialog refuses a schedule and
  period that would keep more locked snapshots than the per-share snapshot limit (`CheckWormLockValid`).
  These checks are client-side only (see below).

**What the NAS does with a written schedule** (DS224+, DSM 7.4.1, 2026-09-28 and 29, on the `backups`
share and an empty scratch share, written with `set_schedule` unless noted):

- Times are NAS-local. This NAS runs on Pacific time, so check `SYNO.Core.System info` `time_zone`
  before reading `hour`, `next_trigger_time` or snapshot names (`GMT-07-...`) as local to you.
- `next_trigger_time` is the true next run in NAS time: 11 schedules written at 03:39 read back
  exactly what `GetScheduleInfo` predicts (every 3 hours from 00:30 gave 06:30; Wednesday-only gave the
  next Wednesday). The one exception is below.
- `get_schedule` keeps reporting a `next_trigger_time` after the schedule is disabled (seen on `arq` and
  the scratch share), so read `enable_snapshot_schedule` there. `snapshot_info` blanks the schedule
  instead, which is why `shares snapshot-config` can treat a next trigger as "enabled".
- Fired and observed in the Snapshot Replication log: once per day at 04:06 on a task created by
  `set_schedule` with `task_id: -1` (the NAS assigned a new id); every 5 minutes with `hour` 4, `min` 0,
  `last_work_hour` 4, which ran 04:35, 04:40, 04:45, 04:50 and 04:55 and stopped, as the formula says;
  and `backups` once per day at 04:30, its first scheduled snapshot after `state apply` restored the
  schedule, immutable for the configured 7 days. Each run is logged about one second after the minute.
- The API accepts shapes the dialog cannot produce, and they do not all work. Every 5 minutes with `min`
  2 (the dialog forces 0) was stored, reported a next run of 03:45, and never ran in 21 minutes of
  watching; nothing was logged. Also stored without error: every 5 hours, `repeat_hour` and
  `repeat_min` both set, `min` 10 with a minute interval, and once per day with `last_work_hour` after
  `hour`; whether those run is unobserved. A schedule that matches what was declared can therefore still
  never run, so write only the shapes in the table above.
- The NAS normalizes two fields: `repeat` is always stored as 0 whatever is sent, and a `last_work_hour`
  before `hour` (a window past midnight) is stored as equal to `hour`.
- `set_worm_lock` does not enforce the dialog's range: with the lock disabled it stored 0, 31 and 400
  days. Whether it refuses them with the lock enabled was not tested, because enabling it on a test share
  locks that share's snapshots for the period.

**Dialog behavior worth knowing before testing by hand.** Changing the interval resets "Last snapshot
time on scheduled days" to the latest time the interval allows (`updateLastWorkTimeStore`: 23:30 for 1
hour, 22:30 for 2 hours from 04:30), so set it before pressing OK. The share's snapshots are immutable for the protection period (7 days here), so a snapshot
that fires by mistake while testing can't be deleted for a week. Choose a window that has already passed
today. The dialog's OK also saves "Enable immutable snapshots" and its protection period, which is the
worm lock above.

**`SYNO.Btrfs.Replica` and `SYNO.Replica.Share` are replication APIs, not local-snapshot config.** On a
NAS that sends backups to C2 rather than receiving replication they return 1001 / 3000 regardless of
params. Those codes read like a missing or malformed parameter and aren't. Adding params won't help.


## `SYNO.Docker.Image` delete wants plural `tags`, an array

`SYNO.Docker.Image` `delete` (v1) takes `images` as a JSON-stringified array of objects, form-encoded
in one field. The object needs `repository` and **`tags`** (plural, an array), matching the shape
`list` returns:

```
images=[{"repository":"example-image","tags":["0.4.0"]}]
```

Singular `tag` is the trap: DSM accepts it, returns `{success:true, data:{}}`, and deletes nothing
(the handler iterates an empty `tags`). Every other selector key (`image=`, `name=`, `reference=`)
returns 114, so `images` is the only recognized key; the object shape inside is what bites. Mutating
`Docker.*` calls also need the `X-SYNO-TOKEN` header (login with `enable_syno_token=yes`, which yields
a token-bound session that then 119s any plain `_sid` call, so send the token on the `list` too). An
image referenced by any container, running or stopped, can't be deleted.
