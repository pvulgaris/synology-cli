# CLAUDE.md: synology-cli

Onboarding for a future Claude session (or any human collaborator). What's here that you can't easily get from the README, the source, or `git log`.

## What this is

`syno`, a CLI over a typed subset of the Synology DSM 7 Web API (packages, security audit, shares, snapshots, backups, storage health, users, firewall, DSM hardening, external access, notifications, certificates) plus an optional read-only SRM router target. It runs on your machine, not on the NAS.

`src/commands.ts` is the authoritative command registry. Dispatch, `--help`, and the skill's command table all derive from it, so a command added there needs no other edit to become invocable and documented.

Response shapes are deliberately frozen. `skills/synology/SKILL.md` maps audit findings to specific fields (`firewall_enabled`, `web_hardening.https_redirect`, `smb.min_protocol`), so reshaping a tool's output silently breaks those rules.

## Session cache and locking

A CLI is a fresh process per invocation, which turns two latent problems into everyday ones: every run would log in, and DSM rejects a second login that reuses the same 30-second TOTP code. So the SID cache in `src/session.ts` is load-bearing, not a dev convenience.

- Session files live at `~/.local/state/syno/session-<label>.json`, mode 0600, written temp-file-then-rename.
- An `O_EXCL` lock file next to it serializes logins across processes, so `syno status & syno shares list &` doesn't race two logins into a TOTP-reuse 404. A lock older than 45s is presumed abandoned and broken.
- When a login genuinely is needed inside the window that produced the last SID, `awaitFreshTotpWindow` waits for the next code rather than burning the current one. That wait is why the stale-lock bound must stay above 30s: a holder waiting out a TOTP window is not stuck.
- The router gets a session file too. The daemon deliberately withheld one (SRM expires sessions faster than the 10-minute TTL, so a stale SID meant 119 → re-login → 404), but that failure mode is exactly what the TOTP-window wait now handles, and withholding the cache from a per-process CLI would guarantee a login on every router call.

## `raw`

`syno raw <api> <method> [--version=N] [--post] [k=v ...]` reaches any DSM endpoint without a named command. It's the first thing to use when adding a tool: probe the endpoint by hand, confirm the shape, then write the command.

`--post` goes through the same `--yes` gate as the named writes, because DSM treats POST as mutating. `--` stops flag parsing so a DSM param can share a name with a CLI flag.

Params are form-encoded and DSM JSON-parses each value, so string params need their quotes on the wire (see the form-encoding gotcha below).

## Writes require `--yes`

Under MCP the client prompted the user before invoking a write tool. Nothing plays that role for a CLI, so the gate lives in `requiresConfirmation` (`commands.ts`) or it doesn't exist at all. Without it an agent composing commands could uninstall a package with no confirmation step.

## Write flow: install & update (two-phase, download then install-from-path)

`src/tools/packages.ts:nasPackageUpdate` runs the DSM UI's exact sequence, re-verified from a HAR capture on 2026-05-20. The first `Installation.upgrade` only downloads the .spk; a **second** `Installation.upgrade` with `path` + `installrunpackage:true` is what actually installs. An earlier implementation thought the first call did everything and silently failed on packages that don't auto-install post-download (HybridShare, FileStation), leaving orphaned .spks in the download temp dir.

1. **`SYNO.Core.Package.feasibility_check`**: preflight.
2. **`SYNO.Core.Package.Installation.get_queue`**: dep planning. Bail on `broken_pkgs`/`conflicted_pkgs`.
3. **`SYNO.Core.Package.Installation.check` v=2**: `blupgrade=true`, `ver`/`size`/`id`. Returns `volume_path`.
4. **`SYNO.Core.Package.Installation.upgrade` v=1**: DOWNLOAD. Params: `name`/`url`/`checksum`/`filesize`/`is_syno`/`beta`/`operation:"upgrade"`. Returns `taskid="@SYNOPKG_DOWNLOAD_<id>"`.
5. **Poll `Installation.status`** until `finished:true`. The .spk is on disk.
6. **`SYNO.Core.Package.Installation.Download.check`**: returns `filename`, the staged .spk path.
7. **`SYNO.Core.Package.Installation.check` v=2**: simpler shape, `id`/`install_type`/`install_on_cold_storage`/`blCheckDep:false`. No `ver`/`size`/`blupgrade`.
8. **`SYNO.Core.Package.Installation.upgrade` v=1**: INSTALL FROM PATH. Params: `path`, `extra_values:"{}"`, `installrunpackage:true`, `force:true`, `check_codesign:true`, `type:0`. Throw on non-empty `worker_message`.
9. **Poll `Package.list`** until `version` flips. `Installation.status` keeps reporting `"upgrading"` long after the actual swap, so it isn't reliable.
10. **`Installation.delete path=<staged>`**: cleanup, best-effort.

`nasPackageInstall` uses the **same two-phase split**. Step 4's `Installation.install` only downloads (status flips to `"installing"` but `Download.check` reports `status:"non_installed"`, and the package never lands in `Package.list`); the commit is a **second** `Installation.install` with `path` + `installrunpackage:true` + `force:true` + `check_codesign:true` (method `install`, not `upgrade`, plus `volume_path`). Before that fix the missing commit made the completion poll wait for a version flip that never came. Install waits are bounded (`INSTALL_DOWNLOAD_TIMEOUT_MS` 3 min, `INSTALL_VERIFY_TIMEOUT_MS` 90s) so a stuck op fails fast with "issued but not confirmed" instead of hanging.

**Dependencies: the queue is the source of truth.** Catalog `depend_packages` is unreliable. It was `null` for Synology Drive Server, which nonetheless requires Universal Viewer. `Installation.get_queue` returns DSM's fully-resolved, ordered plan (deps first, target last), and `nasPackageInstall` executes that flat list verbatim, each entry two-phase. When the queue contains packages beyond the target, the command returns `status:"needs_dependency_confirmation"` listing them (mirroring Package Center's "the following operations will also be performed" dialog) and installs nothing until re-run with `--accept-dependencies`. The second-phase commit on big packages frequently drops the TCP connection mid-call but succeeds server-side, so `applyInstallFromPath` treats network-level errors as soft and confirms via the `Package.list` poll. (With a dependency unmet, `Download.check` returns code **4526** naming the dep, but queue-first execution means that path isn't normally reached.)

**Form-encoding gotcha.** DSM JSON-parses each form value. Strings must carry quotes on the wire (`name="FileStation"`); bools, numbers and null are literal; arrays and objects are JSON-stringified. The code uses `JSON.stringify(...)` for string values so they appear quoted in the form body.

**Uninstall** is a single call: `SYNO.Core.Package.Uninstallation.uninstall` with `id` and `dsm_apps=""`. The `dsm_apps` field is a list of linked DSM apps to remove together, NOT a "keep data" flag.

**Uninstall data deletion is package-specific (HAR-verified 2026-06-23).** Package Center's "Delete the items listed above" checkbox rides `extra_values` carrying a **per-package** wizard key (`"{\"pkgwizard_remove_cstn_db\":true}"` for Synology Drive; ABB and others differ). That key is defined in each package's own client-side uninstall wizard and isn't exposed by any queryable API: `is_uninstall_pages:true` in `Package.list` only flags that a dialog exists, and `Uninstallation` has no precheck method. So we can detect a data-bearing package but can't safely drive its delete-data option blind. `nasPackageUninstall` therefore only ever does the data-preserving uninstall (omit `extra_values`): when `is_uninstall_pages` is true it returns `status:"needs_data_confirmation"` and requires `--keep-data` to proceed, and `--keep-data` omitted is refused with a pointer to the DSM UI, the honest path for actual deletion.

## Router (SRM) support

The CLI optionally targets a Synology router. `SRM_BASE_URL` alone enables it; without it the router commands error out with that hint.

- The router client is **read-only** at the `SynoClient` level (any POST or non-read method is refused). "DSM vs SRM" is expressed entirely as data of type `TargetConfig` (`config.ts`), the slice of `Config` a client actually reads. Because `TargetConfig` has no `router` field, `makeRouterClient(routerTargetFrom(cfg))` is a compile error rather than a runtime guard.
- SRM's package and upgrade reads are admin-gated with no selective grant, so `SRM_USER` must be an admin. SRM does support extra admins (Control Panel → User → "Grant administrator privilege"; the widely-cited "primary admin only" claim is pre-1.3), so use a dedicated account. A Normal user gets code 402 at login.
- **Verified live (SRM 1.3.1 / RT6600ax, 2026-06-26):** router login is at `auth.cgi` with `SYNO.API.Auth` **v3** (DSM's `entry.cgi`/v6 returns 102); SRM reuses `SYNO.Core.Upgrade.Server check` v1 and returns DSM's flat `{available, version}` shape, with `current_version` from `SYNO.Core.System info` at **v1** (v3 is DSM-only, 104s on SRM); SRM's admin-gated reads don't need `enable_syno_token`.
- **SRM has no package-update API.** `SYNO.Core.Package.Server` returns 103, so there is deliberately no `router packages updates` command. The `syno updates` digest carries that as an honest note on its `router_packages` source instead.
- OS detection is detect-only. Applying DSM or SRM updates stays deferred (brick risk). `mapOsUpdate` only reports `available:true` when a concrete version is named, biasing to silence over crying wolf.

## DSM API quirks (the consolidated cheatsheet)

Error codes, response shapes, and known API names live in [`docs/dsm-api-quirks.md`](docs/dsm-api-quirks.md). Read it before adding a command or debugging an unexpected `code:` error. Highlights:

- Error 114 = "Lost parameters" (NOT "API key mismatch"). 5100 = "Unable to perform" (NOT empty list).
- `requestFormat: "JSON"` in `SYNO.API.Info` describes the **response**, not the request. Always send form-encoded.
- `additional[]` response keys are FLAT on User/Share objects but NESTED under `additional` on Package objects.
- Per-adapter calls (DoS, GeoIP) use `configs=[{adapter: ifname}, ...]` as a JSON-stringified single form field.
- State-changing POSTs frequently drop the TCP connection mid-execution while completing server-side. Catch network-level errors and verify via a status or list poll.

## Hard-won lessons

Each of these was a real bug.

### The DSM account has to be in `administrators`

DSM 7's admin APIs (`SYNO.Core.Package.*`, `SYNO.SecurityAdvisor.*`, `SYNO.Core.User.*`, `SYNO.Core.Share`) gate on `administrators` group membership. There's no selective-grant mechanism; DSM's "Application Privileges" page covers only end-user services (File Station, SMB, AFP). An earlier draft of this repo planned a non-admin `claude-mcp` user, which was wrong about what DSM supports.

An admin does have File Station and share access, so the real compensating controls are: password never typed (kept in a password manager, read from a `*_FILE`/env secret), 2FA TOTP enforced, no SSH service running, and a network ACL restricting DSM's ports to your devices.

### DSM rejects TOTP code reuse within the 30s window

A login generates a TOTP code; if that exact code was used in the last 30 seconds, DSM answers with code 404, "Failed to authenticate 2-factor authentication code." That reads like a wrong password, not a rate limit, which is why it's worth waiting out rather than retrying into. The session store handles this (see above); the failure surfaces only if you delete the session file mid-sequence.

### `SYNO.Core.Package.Server.list?tab=update` is the catalog, not pending updates

It returns every package installable on this DS (105+ items) with no `installed_version` field. Pending updates come from joining it with `SYNO.Core.Package.list` (the installed set with versions) and filtering to items where `installed_version` is set AND differs from the catalog version. See `tools/packages.ts:nasPackagesCheckUpdates`.

### DSM Web API is reverse-engineered, not specced

`SYNO.*` is not a public, versioned spec. Synology publishes a partial guide (mainly Auth and FileStation); the rest is reverse-engineered from DSM's own JS clients. When adding a command, inspect DSM's UI network tab for the exact api/method/version/params the official client sends, then mirror it. Don't trust third-party docs alone. Widely-cited community references lag current DSM behavior, and following one shipped an upgrade bug here before the real flow was pulled from a HAR.

### Hard refusals live in `tools/packages.ts`, not the command registry

`HARD_REFUSE_NAMES = new Set(["DSM", "kernel"])`. If you want to add a refusal at the dispatch layer, push it down into the tool function instead, so the JSONL audit log captures the rejected attempt with full args. A dispatch-layer refusal is silent from the audit's perspective.

### `protect:` policy is skill-layer, not binary-enforced

`skills/synology/SKILL.md` loads a per-user policy file naming packages the user doesn't want offered for uninstall (HyperBackup, ContainerManager, Tailscale). The binary doesn't read that file; refusal happens in the calling skill before it ever runs `syno packages uninstall`. Binary-side hard refusals are only `DSM` and `kernel`. The policy file's location and format are the user's choice.

### TLS verification is process-wide via `NODE_TLS_REJECT_UNAUTHORIZED=0`

A per-fetch `undici` Agent for scoped TLS skip was tried and reverted: it interacted badly with Node 22's built-in fetch (intermittent "fetch failed" plus silently-empty responses on some endpoints). The skip is now set process-wide at startup when `cfg.tlsSkipVerify` is true. The blast radius is bounded to DSM-shaped targets (the NAS, and SRM when configured, both self-signed). If you add a non-Synology outbound, route THAT call through a per-call verifying Agent (`rejectUnauthorized:true`) to override the global skip. The enforcing direction is safe on Node 22; only the skipping per-fetch agent broke.

Worth knowing: the router login transmits the SRM admin password over the unverified self-signed link, so a LAN MITM between you and the router could harvest it. Pin the SRM cert if that's in your threat model.

### No `synology-api` npm dep on purpose

Several `synology-*` npm packages exist. None covered `SYNO.Core.Package`, `SYNO.SecurityAdvisor.*`, and `SYNO.Core.Share` with the field-level options needed here. Rolling a thin client (~200 lines in `dsm.ts`) was cleaner than wrapping a community lib for partial coverage. Don't add one unless it grows into mature coverage.

## Deliberately deferred (don't pre-build)

Conscious omissions, not gaps. If a request actually needs one, add it then.

- Firewall rule edits, 2FA enforcement changes, SMB protocol toggles. Out of scope; surface as findings only.
- DSM self-update. Would brick the connection mid-call.
- Btrfs snapshot creation. Reading snapshots is supported; taking one belongs in the DSM UI.
- Recent-logins, SecAdvisor history. Neither maps to a stated user request.
- An audit-log read command. The JSONL is on disk; reading it is a filesystem op.
- Cold-storage installs. `install_on_cold_storage` is passed through from the catalog to `Installation.check`; if DSM refuses, fall back to the UI.
- Package-specific `extra_values` (SurveillanceStation needs `chkSVS_Alias: true`). DSM's UI handles these via dedicated dialogs. The install path uses the upgrade-style shape that doesn't require them; install such a package via the UI once and let the persisted state cover later updates.
