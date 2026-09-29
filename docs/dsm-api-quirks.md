# DSM 7 Web API quirks

Consolidated notes on the Synology DSM 7 Web API surface, derived from live probing and reverse-engineering work on this project. Read before adding new tools, debugging unexpected `code:` errors, or interpreting `SYNO.API.Info` output.

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

The following `SYNO.Virtualization.Guest` v1 calls were observed to return discovery data without changing persistent VMM state. The raw-command confirmation policy treats only these exact API and method pairs as read-only exceptions:

- `list_resource`
- `check_availability`
- `gen_mac`
- `read_ovf`, which requires POST and parses an OVA already present on DSM

`SYNO.Virtualization.Cluster.get_total_progress` v1 is also a read-only poll.
It reports progress for a supplied `prefix`, such as `virtualization_guest`,
and is an exact raw-command confirmation exception.

## Container Manager observations

`SYNO.Docker.Container.stats` v1 is a GET read that returns Docker stats keyed
by container ID. Each record includes the container name and raw CPU, memory,
network, and block-I/O counters. Stopped containers remain in the response with
empty counters and a zero-date `read` timestamp. CPU percentage requires two
snapshots because DSM returns an empty `precpu_stats` record.
The raw-command confirmation policy treats this exact endpoint as a read-only
exception because `stats` is not otherwise a recognized read method name.

`SYNO.Docker.Container.get` v1 accepts a JSON-quoted `name` and returns
`{details, profile}`. Both branches may include environment values and command
arguments, so named reads suppress raw response tracing. The supported
`containers info` output omits environment values and redacts secret-shaped
command options.

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

**`SYNO.Core.User.list` `expired` field — dated form is unverified.** Known values are `"normal"`
(active) and `"now"` (disabled; this is how "Disable this account" manifests). DSM is understood to
also put a *date* here for a scheduled expiration, but the exact format has never been observed on a
live DSM, and a date-only value can't be judged reliably without the NAS's timezone. So `userActive`
(`tools/security.ts`) classifies only the two known sentinels and flags everything else
`active_indeterminate` rather than guessing. Do NOT reach for `Date.parse` here: it reads `"0"`,
`"1"`, `"2026"` as valid past dates and would silently mark such an account disabled, suppressing the
audit findings this is meant to make reliable. If the dated format is ever confirmed live, classify it
with a strict format check plus a whole-day, timezone-safe comparison, not `Date.parse`.

**`SYNO.Core.Package.Server.list` (the catalog, not the installed-package list) uses its own field
names, not the ones you'd guess from `Package.list` or the Package Center UI's labels:** display
name is `dname` (not `name`), publisher is `maintainer` (not `publisher`), description is `desc`
(not `description`), and dependencies are `deppkgs` (a `{pkgId: versionConstraint}` map or `null`
— not `depend_packages`). There is no `install_dep_packages` field on this endpoint at all;
`Installation.get_queue` is the resolved-plan source of truth (see the write-flow section in
CLAUDE.md). `nas_package_info` and `nas_packages_check_updates` shipped for a while silently
mapping the wrong keys — `JSON.stringify` drops `undefined` fields, so the gap only surfaced via a
live smoke test, not a type error (`dsm.call<T>()` performs an unchecked cast, so a wrong field
name in the TS interface never fails at compile time). `changelog`, `size`, and `beta` happen to be
named the same on both endpoints, which is what let the bug hide for the fields that did work.

## API name + method discoveries

These took multiple sessions to pin down:

- **HTTPS-redirect / HSTS**: `SYNO.Core.Web.DSM` v=2 `get` (no params)
- **TLS profile per service**: `SYNO.Core.Web.Security.TLSProfile` v=1 `get`
- **DoS protection**: `SYNO.Core.Security.DoS` v=2 `get` with `configs=[{adapter},...]`
- **Network interfaces (for the `configs=` pattern)**: `SYNO.Core.Network.Interface` v=1 `list`
- **Firewall rules per profile**: list profiles via `SYNO.Core.Security.Firewall.Profile` v=1 `list`, then `get` per `name`. There is NO `Firewall.Rules.list`.
- **AutoBlock entries**: `SYNO.Core.Security.AutoBlock.Rules` v=1 `list` with `type=allow|deny` AND `offset`/`limit`. Missing any param → 5100.
- **Port forwarding**: `SYNO.Core.PortForwarding.Rules` v=1 `load` (NOT `list`). Returns a bare array.
- **Package stop/start/restart**: `SYNO.Core.Package.Control` v=1 with `method=stop|start|restart`, POST, `id=<pkg>`.
- **Security Advisor scan**: `SYNO.Core.SecurityScan.Operation` v=1 `start` (POST, `items=ALL`) → poll `SYNO.Core.SecurityScan.Status` v=1 `system_get` until `sysProgress>=100` → fetch findings via `rule_get` (`items=ALL`).
- **QuickConnect state**: `SYNO.Core.QuickConnect` v=2 `get` for master toggle + alias; v=3 `get_misc_config` for `relay_enabled`.

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
- **Container and image lists require pagination**: `SYNO.Docker.Container list` needs `offset=0`, `limit=<n>`, and `type="all"`; `SYNO.Docker.Image list` needs `offset=0` and `limit=<n>`. Omitting them returns code 114 rather than a default page.
- **Project update does not recreate containers**: `SYNO.Docker.Project update` replaces the stored Compose content, but `start` then starts the old containers. Stop, update, and call `build` to converge containers to the new definition.
- **Project build does not remove orphans**: Container Manager's Compose wrapper does not pass `--remove-orphans`. A service removed from the Compose document can remain as an exited or restarted container until explicitly deleted.
- **Project code 1202 is ambiguous**: a build with a successful one-shot service can return 1202 and set project status `WARNING` while the service exited 0 and the long-running containers are healthy. Stop can also return 1202 after stopping containers. Poll the project and verify container running/health/exit state before deciding success or failure.
- **Container logs are a read over POST**: `SYNO.Docker.Container.Log get`, POST, needs `name`, `sort_dir`, `offset`, and `limit`. Do not classify it as a mutation solely because it uses POST.
- **Image deletion is not wrapped**: Container Manager 24.0.2 rejected the documented private `SYNO.Docker.Image delete` parameter forms. Keep image removal out of named commands until its contract is verified on the current DSM build. Do not work around it by exposing the Docker socket through this CLI.
- **TOTP code reuse window**: DSM rejects the same TOTP code within ~30 seconds. The error is code 404 "Failed to authenticate 2-factor authentication code." Persist the post-login SID (e.g. via `DSM_SID_CACHE_FILE`) across rapid dev iteration so you don't burn a new code per process.
- **SMB protocol enum is 0-indexed** (`SYNO.Core.FileServ.SMB` → `smb_min_protocol` / `smb_max_protocol`): `0`=SMB1, `1`=SMB2, `2`=SMB2+Large MTU, `3`=SMB3. So a `smb_min_protocol` of **1 is SMB2, not SMB1** — SMB1 is only permitted when the minimum is `0`. The `max_protocol: 3` (SMB3, the default ceiling) is the tell that the scale is 0-based. Deriving "SMB1 enabled" from `<= 1` is an off-by-one that mis-flags a healthy SMB2 minimum as a critical finding (`security.ts` `enable_smb1`; skill audit rule `synology.smb.smb1_enabled`).
- **TLS profile levels are INVERSELY numbered** (`SYNO.Core.Web.Security` / `SYNO.Core.Security.TLSProfile` → `default-level`, per-service `current-level`): `0`=Modern (strongest), `1`=Intermediate, `2`=Old/Compatible (weakest). Verified against a live NAS: a `dsm` service at `current-level: 0` accepts only TLS 1.2/1.3 with PFS+AEAD ciphers and rejects all CBC/SHA1/3DES. So a service is **downgraded (weaker) when `current-level > default-level`**, not less — the intuitive "higher number = stronger" is backwards here. Same misread class as the SMB enum: it made a hardened service (level 0 under a default of 2) look downgraded.
- **Mail notification recipients moved to `profiles` in DSM 7.3** (`SYNO.Core.Notification.Mail.Conf` → call at **version 2**, not 1): the legacy flat `mail` array is now always `[]`; the actual recipients live in a `profiles` list ("Recipient Profiles" in the UI), each `{ target_type: "mail", target_name: "<label>", target_config: { mail: "<addr>" } }`. Counting the v1 `mail` array reports zero recipients even when one is configured — verified from a DSM UI HAR. Read `data.profiles` filtered to `target_type === "mail"`, and take the address from `target_config.mail` (the authoritative address) rather than `target_name` (a display label that may differ). Because DSM predating 7.3 may not serve v2 at all, **call v2 first and fall back to a real v1 `get`** (which returns the flat `mail` array) — don't rely on the `mail` field inside a v2 response for older DSM, since a v2-unsupported error nulls the whole response. The other fields (`enable_mail`, `enable_oauth`, `smtp_info.*`, `sender_mail`, `subject_prefix`) are unchanged between v1 and v2.

## Btrfs snapshot config: summary on `SYNO.Core.Share`, writes elsewhere

Discovered live on 2026-07-20 against DSM 7.3.2-86009 Update 4. Finding the schedule and retention
policy for a share's snapshots costs a session if you start from the obvious API, so start here.

**Task config (schedule + retention) is an `additional` field on `SYNO.Core.Share` `get` v1**, requested
as `additional=["snapshot_info"]`. The response carries:

- `snapshot_info.retention` is the Smart Recycle GFS policy: `advHourly`, `advDaily`, `advWeekly`,
  `advMonthly`, `advYearly`, plus `advPolicyType`, `retainDay`, `policyType`.
- `snapshot_info.schedule` carries `hour`, `min`, `week_name`, `date_type`, `next_trigger_time`.

`next_trigger_time` is the practical "the schedule is enabled" signal. There is no separate enabled
flag, so a share with no scheduled snapshots is one with no next trigger.

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

**Per-snapshot immutability** (`immutable`, `immutable_days`, `immutable_until`, `scheduled`,
`user_locked`) comes from `SYNO.Core.Share.Snapshot list` at **v2**, which `syno shares snapshots`
already wraps.

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
