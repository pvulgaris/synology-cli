---
name: synology
description: Manage a Synology NAS (DSM 7) and SRM router via the `syno` CLI: packages, security audit, shares, snapshots, backups, storage health. Use when the user asks about NAS status, package updates / research / installation / removal, or security posture.
---

# Synology NAS

`syno` is a command-line tool that talks to DSM's Web API. Every command prints JSON on stdout (pipe it to `jq`); the DSM call trace goes to stderr. Exit 0 on success, 1 on failure, 2 on a usage error.

Auth is owned by the CLI: it reads DSM credentials from the environment, logs in, and caches the session. The DSM account is in the `administrators` group because DSM 7 gates its admin APIs on that membership. Compensating controls (2FA, no SSH service, network ACL) live outside this skill, so don't relax them.

`syno --help` lists every command. This file covers what `--help` can't: which commands to compose for a given request, and how to turn their output into stable audit findings.

## When to use

- **Status + storage**: "is the NAS okay?", "drive health", "RAID state".
- **Packages**: list installed, check for updates, get info, install, update, uninstall.
- **Package research**: "what's a good package for X?", "should I install Y?". Compose with WebSearch plus `syno packages list` so you don't recommend what's already installed.
- **Security audit**: "audit security", "is my NAS configured safely?". Fan out the read commands below and group the findings.

## Command inventory

**Read commands (free to invoke):**

| Command | Returns |
|---|---|
| `syno status` | model, DSM version, uptime, temp, CPU/memory |
| `syno storage` | volumes (RAID, size), drives (S.M.A.R.T., temp) |
| `syno packages list` | installed packages + versions + status |
| `syno packages updates` | pending updates (excluding DSM itself) |
| `syno packages info <name>` | metadata for one package (publisher, changelog, deps) |
| `syno security scan` | Security Advisor check counts + the failing rules (passes/skips are counted, not listed) |
| `syno users list` | accounts, 2FA on/off, expired flag |
| `syno security firewall` | rules, auto-block, per-adapter DoS protection |
| `syno security settings` | web hardening (HTTPS-redirect/HSTS/CSRF/CSP/IP-check/session-timeout), TLS profile per service, SSH, SMB, NFS, auto-update, password policy, Active Insight |
| `syno shares list` | shares incl. encryption, quota (mb used/total), recycle-bin, snapshot support |
| `syno shares snapshots <share>` | Btrfs snapshots for one share, with immutable/WORM lock state |
| `syno backup tasks` | Hyper Backup tasks: destination, encryption, schedule, last result. Returns `{ tasks: [], note }` if Hyper Backup isn't installed, not an error |
| `syno tasks list` | DSM Task Scheduler entries |
| `syno external` | QuickConnect, DDNS, App Portal HTTPS-per-app, reverse-proxy rules, port forwarding |
| `syno notifications` | SMTP mail config: server, ssl, verify-cert, sender, recipient count |
| `syno certificates` | cert inventory with `days_until_expiry`, services, self-signed flag |
| `syno updates` | pending updates across DSM OS, NAS packages, router OS, router packages |
| `syno dsm update-check` | whether a DSM OS update is available (detect only) |
| `syno router update-check` | whether an SRM router OS update is available (detect only) |

**Write commands (require `--yes`, see Write flow below):**

| Command | Effect | Returns |
|---|---|---|
| `syno packages install <name> --yes` | Install a package from the Synology repo | `{ before, after, verified }` |
| `syno packages update <name> --yes` | Update an installed package to latest | `{ before, after, verified }` |
| `syno packages uninstall <name> --keep-data --yes` | Remove a package, preserving its data | `{ before, after, removed }` |
| `syno packages control <name> <start\|stop\|restart> --yes` | Start/stop/restart a package | status poll result |

## The `raw` escape hatch

Anything DSM exposes but `syno` has no named command for is reachable with:

```
syno raw <api> <method> [--version=N] [--post] [k=v ...]
```

Params are form-encoded and DSM JSON-parses each value, so **string params need their quotes on the wire**: `name='"FileStation"'`. Bools and numbers are literal (`beta=false`), arrays and objects are JSON-stringified. `--post` is a write in DSM's eyes and needs `--yes` like any other write.

Use `--` to stop flag parsing when a DSM param name collides with a CLI flag: `syno raw SYNO.Foo get -- --version=3` sends a literal param rather than setting the API version.

Prefer a named command when one exists. Reach for `raw` to explore a new endpoint or to answer a one-off question, and read `docs/dsm-api-quirks.md` first. Most surprising `code:` errors are documented there.

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
4. Check `verified === true` (or `removed === true`) in the output. On any mismatch, surface it loudly. Silent drift is the worst outcome.
5. Repeat from step 1 for the next package. Never bundle multiple writes in one turn.

If a write returns `verified: false`, surface the entire `{ before, after, error }` payload. Don't retry automatically. The likeliest cause is a Package Center precondition (TOS acceptance on a fresh account, a package conflict) that needs human judgment.

Installing a package with dependencies returns a plan instead of installing. Re-run with `--accept-dependencies` once the user has seen the list.

Uninstall only ever preserves data. `--keep-data` is required to proceed; actual data deletion is package-specific and belongs in the DSM UI.

First-time-only gotcha: if Package Center calls return odd errors on a freshly-created DSM account, the user may need to log into the DSM UI as that account once and accept the Package Center TOS. Offer it as a hypothesis on a brand-new install only.

**Hard refusals** (the CLI rejects these):
- `syno packages update DSM`: DSM self-updates are out of scope; apply via the DSM UI.
- Kernel-flagged packages, same reason.
- Firewall rule edits, 2FA enforcement changes, SMB protocol toggles aren't implemented. Surface them as findings with the DSM UI path to fix.

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
| `synology.users.admin_active` | user `admin` not in expired state |
| `synology.users.guest_active` | user `guest` not in expired state |
| `synology.users.no_2fa` | per-user finding when `otp_enabled === false` on a non-disabled account |
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
