---
name: synology
description: "Manage a Synology NAS (DSM 7) and SRM router via the `syno` CLI: Container Manager, packages, security audit, shares, snapshots, backups, storage health. Use when the user asks about NAS status, containers, package updates / research / installation / removal, or security posture."
---

# Synology NAS

`syno` is a command-line tool for DSM and SRM. Every command prints JSON on stdout (pipe it to `jq`); concise progress and errors go to stderr. Add `--verbose` only when the API trace is needed. Exit 0 on success, 1 on failure, 2 on a usage error.

Auth is owned by the CLI. It loads and caches only the selected target. DSM uses `DSM_*`; SRM uses `SRM_*` and works without DSM configuration. The DSM account is in the `administrators` group because DSM 7 gates its admin APIs on that membership. SRM is read-only at the client layer.

Use `syno help --json` for the authoritative command, input, platform, and mutation inventory. This file covers which commands to compose for a request and how to turn their output into stable audit findings.

## When to use

- **Status + storage**: "is the NAS okay?", "drive health", "RAID state".
- **Packages**: list installed, check for updates, get info, install, update, uninstall.
- **Containers**: inspect containers, projects, logs, and images; deploy an existing Compose project; control or remove a container.
- **Package research**: "what's a good package for X?", "should I install Y?". Compose with WebSearch plus `syno packages list` so you don't recommend what's already installed.
- **Security audit**: "audit security", "is my NAS configured safely?". Fan out the read commands below and group the findings.

## The `raw` escape hatch

Anything the selected Synology target exposes but `syno` has no named command for is reachable with:

```
syno raw <api> <method> [--target=dsm|srm] [--version=N] [--post] [--params-json=JSON] [k=v ...]
```

Prefer `--params-json` so the CLI handles Synology's wire quoting. The trailing `k=v` form sends direct wire values. Do not combine the forms. `--post` and non-read methods need `--yes` unless the exact endpoint is verified as read-only; SRM refuses all mutations even with confirmation.

Use `--` to stop flag parsing when a DSM param name collides with a CLI flag: `syno raw SYNO.Foo get -- --version=3` sends a literal param rather than setting the API version.

Prefer a named command when one exists. Reach for `raw` to explore a new endpoint or to answer a one-off question, and read `docs/dsm-api-quirks.md` first. Most surprising `code:` errors are documented there. `raw` also gates non-read method names even when they use GET, because DSM does not consistently align mutation with POST.

## Provisional automatic IPv6 workflow

Use this only when the user asks to set one DSM interface to automatic IPv6.
The API shape is an observation recorded in `docs/dsm-api-quirks.md`, not a
general network-settings contract. Do not adapt it to static addresses,
gateways, bonds, VLANs, or other modes.

1. Read the current interfaces:
   ```sh
   syno raw SYNO.Core.Network.Ethernet list --version=2
   ```
2. Select the exact `ifname`. Stop if it is absent or its `ipv6` array is
   nonempty because this read does not identify the configured mode.
3. Render this confirmation block and wait for a literal `yes`:
   ```text
   Update proposed:
     interface: <ifname>
     action:    set IPv6 configuration to automatic
     before:    no IPv6 address observed
     after:     IPv6 address assigned automatically
   Confirm? (yes/no)
   ```
4. Read the **Automatic IPv6 on one interface** section in
   `docs/dsm-api-quirks.md`. Replace both `INTERFACE` values in its parameter
   object with the verified `ifname`, then pass that object as `<JSON>`:
   ```sh
   syno raw SYNO.Entry.Request request --version=1 --post --yes --params-json='<JSON>'
   ```
5. Re-read `SYNO.Core.Network.Ethernet` v2 `list`. Report success only when the
   selected interface has a nonempty `ipv6` array. If the write reports a
   transport failure, still perform this read because the change may have
   completed. If the address remains absent, report the result as unverified
   and do not repeat the write.

## Write flow

Writes need `--yes` on the command line. Nothing prompts you, so the confirmation gate is yours to run. **No silent writes, no batched writes across multiple packages in one turn.**

For each write:

1. Read the current state first (`syno packages list` or `syno packages info <name>`).
2. Render this exact confirmation block in prose and wait for a literal `yes`:
   ```
   Update proposed:
     package: <name>
     action:  <install | uninstall | update>
     before:  <current version or "not installed">
     after:   <expected version or "removed">
   Confirm? (yes/no)
   ```
   Anything other than `yes` aborts. Don't infer consent from "sure", "ok", "go ahead".
3. Run the command with exactly the args you just confirmed, plus `--yes`.
4. Check the command exit status. Container writes return only after verification. For package writes, also check `verified === true` (or `removed === true`) in the output.
5. Repeat from step 1 for the next package. Never bundle multiple writes in one turn.

If a package write returns `verified: false`, surface the entire `{ before, after, error }` payload. Don't retry automatically. The likeliest cause is a Package Center precondition (TOS acceptance on a fresh account, a package conflict) that needs human judgment.

Installing a package with dependencies returns a plan instead of installing. Re-run with `--accept-dependencies` once the user has seen the list.

Uninstall only ever preserves data. `--keep-data` is required to proceed; actual data deletion is package-specific and belongs in the DSM UI.

First-time-only gotcha: if Package Center calls return odd errors on a freshly-created DSM account, the user may need to log into the DSM UI as that account once and accept the Package Center TOS. Offer it as a hypothesis on a brand-new install only.

**Hard refusals** (the CLI rejects these):
- `syno packages update DSM`: DSM self-updates are out of scope; apply via the DSM UI.
- Kernel-flagged packages, same reason.
- Firewall rule edits, 2FA enforcement changes, SMB protocol toggles aren't implemented. Surface them as findings with the DSM UI path to fix.

## Container project deploy flow

`syno containers projects deploy` is for an existing Container Manager project. It resolves a name to the live project id, stops its running containers, uploads the local Compose document as the project definition, calls `Project.build`, and polls the project until every long-running container is ready. A completed one-shot service is accepted only when it exited 0.

The CLI treats DSM code 1202 and a dropped connection as ambiguous during project stop/build, then verifies the project state. It never calls a failed deploy successful based on the API response alone. Container Manager's build wrapper does not remove orphan containers, so inspect `containers projects info` after removing a service and confirm any orphan separately before `containers remove`.

The Compose document is sensitive even when the current file has no secret: environment values may add one later. Its request trace and audit value are redacted. The audit keeps the local file path and SHA-256 instead.

## Protected packages (per-user policy)

The user maintains a `protect:` list of packages that must never be offered for uninstall, even if they look dormant. This is skill-layer only, the binary knows nothing about it. Load the list at the start of any cleanup workflow from whatever path the user has configured, and never offer a protected package.

## Audit log

Every write is logged as JSONL under the CLI's state directory (`~/.local/state/syno/audit/YYYY-MM.jsonl` by default, `AUDIT_LOG_DIR` overrides), with timestamp, command, args, before/after state, ok flag, and error. Surface the path when the user asks "what did Claude do?" so they can read it themselves.

## Composition examples (do not script; Claude composes)

- **Package update from a Synology notification email**: search Gmail for the notification, cross-reference with `syno packages updates`, render a per-package summary, confirm one at a time, run `syno packages update <name> --yes`, archive the email once all confirmed updates succeed.
- **Security audit**: fan out the read commands in parallel, group findings by severity, present DSM UI fix paths. Never auto-remediate.
- **Cleanup**: list packages, bucket as active / dormant / candidate (system and protected packages never appear as candidates), present the dormant and candidate list with reasoning, confirm one at a time. **Only packages with `additional.install_type !== "system"` are user-removable**. The DSM UI hides the uninstall button on system-marked packages even when they show up in Package Center.

## Audit finding IDs

When composing security-audit output, attach a stable `id: synology.<category>.<short_name>` to each finding so the user can diff across runs and you can track which findings stay open. Response shapes are the same ones these rules were written against, so the field paths below are literal.

| ID | Trigger |
|---|---|
| `synology.firewall.disabled` | `syno security firewall` → `firewall_enabled === false` |
| `synology.firewall.dos_off_on_adapter` | one entry per adapter with `dos_protect_enable === false` (include adapter name) |
| `synology.dsm.https_redirect_off` | `web_hardening.https_redirect === false` |
| `synology.dsm.hsts_off` | `web_hardening.hsts === false` |
| `synology.dsm.tls_profile_downgraded` | any service `current-level > default-level` (TLS levels are inverse: 0=Modern/strongest, 2=Old/weakest, so a HIGHER current-level than default means weaker; include service name) |
| `synology.dsm.default_dsm_ports` | `web_hardening.http_port === 5000` or `https_port === 5001` |
| `synology.smb.smb1_enabled` | `smb.min_protocol === 0` (DSM enum is 0-indexed: 0=SMB1, 1=SMB2, 2=SMB2+LargeMTU, 3=SMB3, so a `min_protocol` of 1 is SMB2 and is **not** a finding) |
| `synology.ssh.enabled` | `ssh_enabled === true` (mostly an observation; flag if the network ACL isn't tight) |
| `synology.users.admin_active` | user `admin` with `active === true`. The CLI computes `active` from DSM's `expired` field, so read the boolean; don't re-interpret `expired` here |
| `synology.users.guest_active` | user `guest` with `active === true` |
| `synology.users.no_2fa` | per-user finding when `otp_enabled === false` AND `active === true`. If a user carries `active_indeterminate: true` (the CLI couldn't classify its `expired` value), still raise the finding and say the account state needs a manual check |
| `synology.notifications.no_recipients` | `mail.recipients_count === 0` while `mail.enabled === true` |
| `synology.notifications.smtp_verify_cert_off` | `mail.verify_cert === false` |
| `synology.shares.no_encryption` | per-share when `encryption === 0` and the share holds user data |
| `synology.shares.no_recycle_bin` | per-share when `recycle_bin === false` on a user-data share |
| `synology.cert.expiring_soon` | per-cert when `days_until_expiry < 30` |
| `synology.external.quickconnect_relay_on` | `quick_connect.enabled === false` AND `relay_enabled === true` (half-configured) |
| `synology.password.weak_policy` | fields nest under `password_policy.strong_password`: `min_length < 12` (only meaningful when `min_length_enable === true`), `included_special_char === false`, `history_num === 0` |
| `synology.privacy.active_insight_on` | `active_insight.monitoring_service === true` (observation only) |
| `synology.packages.outdated` | `syno packages updates` → `pending` non-empty |

The point isn't exhaustive coverage, it's stable IDs for the load-bearing findings. New checks coin new IDs in the same pattern (`synology.<category>.<short_name>`).
