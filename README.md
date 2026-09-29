# synology-cli

`syno` is an agent-oriented command-line tool for Synology DSM and SRM devices. It provides curated commands for common operations and a target-aware `raw` escape hatch for the rest.

Every command prints JSON on stdout, so you can pipe it straight to `jq`. Concise progress and errors go to stderr; `--verbose` adds the Synology API trace. Exit 0 on success, 1 on failure, 2 on a usage error, 3 when `syno state` finds drift.

## Install

```sh
npm install -g .
syno --help
```

That puts `syno` on your `PATH`. Node 22 or newer.

## Configure

Configure DSM, SRM, or both. A command loads only the target it uses.

| Env | Meaning |
|---|---|
| `DSM_BASE_URL` | DSM target, e.g. `https://nas.example.test:5001` |
| `DSM_USER` | DSM account name (default `claude-mcp`) |
| `DSM_PASSWORD` | account password |
| `DSM_TOTP_SECRET` | TOTP seed for the account's 2FA |

The account must be in the `administrators` group. DSM 7 gates its admin APIs on that membership and offers no selective grant.

Every secret also accepts a `*_FILE` form (`DSM_PASSWORD_FILE`, `DSM_TOTP_SECRET_FILE`) naming a file to read it from. Setting both forms of the same secret is refused. Symlinks are refused. How the value gets there is up to you: a 0600 file, a plain export, or a secret-manager launcher. There's no built-in secret-manager dependency.

Configure SRM independently when needed. Process settings apply to both targets.

| Env | Meaning |
|---|---|
| `SRM_BASE_URL` | SRM target, e.g. `https://router.example.test:8001`. |
| `SRM_USER`, `SRM_PASSWORD`, `SRM_TOTP_SECRET` | router login (also `*_FILE`). Must be an SRM admin; usage is read-only. |
| `AUDIT_LOG_DIR` | where write operations are logged. Default `~/.local/state/syno/audit/`. |
| `TLS_REJECT_UNAUTHORIZED` | anything but `0` enforces cert validation. Defaults to skipping for self-signed Synology certificates. |

`SRM_*` is independent of `DSM_*`. For example, `syno router update-check` and `syno raw --target=srm ...` work with no DSM configuration. SRM remains read-only.

Each target's session is cached independently under `~/.local/state/syno/` so back-to-back invocations don't each burn a login and a 2FA code.

## Commands

`syno --help` lists commands for people. `syno help --json` returns the same
registry with arguments, flags, supported platforms, and mutation status for
agents. The registry is the command inventory; it is not duplicated here.

Each command runs against one device. Nothing fans out across both, so a
question spanning the NAS and the router is answered by composing commands and
merging their JSON.

## Writes require `--yes`

Any command marked **write** refuses to run without `--yes`. So does `syno raw` for POST or a method outside its read allowlist, except for endpoint-specific calls verified as read-only.

```sh
syno packages update SynologyDrive --yes
```

Nothing prompts you. The flag is the confirmation.

Two hard refusals: updating DSM itself and updating kernel-flagged packages. Apply those through the DSM UI. Firewall rule edits, 2FA policy changes, and SMB protocol toggles aren't implemented either; they surface as audit findings only.

Uninstall always preserves package data. Actual data deletion is package-specific and belongs in the DSM UI.

Every write is appended to a monthly JSONL audit log with the before/after state. Project deploy records the Compose file's SHA-256, not its content, because Compose environment values may contain credentials.

## Declared state

`syno state check <file>` compares the NAS with an expected-state JSON file and
exits 3 on drift; `syno state apply <file> --yes` converges the fields with a
verified write path, reads the NAS again, and exits 3 if any drift remains. The
file declares a share (`vol_path`, `btrfs_cow`, `recycle_bin`, `encryption`,
`support_snapshot`), the account that writes to it (`description`,
`password_never_expire`, and a read-only share permission), and the share's
snapshot schedule, Smart Retention counts and immutable window, and optionally
its complete NFS export rule set (`"rules": []` declares it not exported). The schedule's
`repeat`, `repeat_hour`, `repeat_min` and `last_work_hour` are DSM's own fields,
described in `docs/dsm-api-quirks.md`. Apply sets
the permission, schedule, retention, immutability and export rules; creating the
share or the account, and turning the NFS service on, stay DSM steps. Unknown keys and wrong types are usage errors, so a
typo cannot skip a check.

```json
{
  "share": {"name": "backups", "vol_path": "/volume1", "btrfs_cow": true, "recycle_bin": false, "encryption": 0},
  "account": {"name": "backups", "description": "Managed backup account: backups", "password_never_expire": true},
  "snapshots": {"enabled": true, "time": "04:30", "week_days": [0, 1, 2, 3, 4, 5, 6],
                "repeat": 0, "repeat_hour": 0, "repeat_min": 0, "last_work_hour": 4,
                "smart_recycle": {"hourly": 24, "daily": 7, "weekly": 2, "monthly": 1, "yearly": 0},
                "immutable_days": 7}
}
```

## `raw`

For anything without a named command, select DSM by default or SRM explicitly:

```sh
syno raw SYNO.Core.Share get --version=1 name='"docs"'
syno raw SYNO.Core.System info --target=srm --params-json='{}'
```

`--params-json` handles Synology's wire quoting for strings, booleans, numbers, arrays, and objects. The trailing `k=v` form remains available for direct wire values. Do not combine the two forms.

`raw` requires `--yes` for POST and for any method that isn't on its read-method allowlist. Endpoint-specific exceptions cover calls verified as read-only. Synology has mutating endpoints that use GET, so the HTTP verb alone is not a safe write boundary. SRM's target policy refuses every mutation even with `--yes`.

See [`docs/dsm-api-quirks.md`](docs/dsm-api-quirks.md) for error codes, cross-API rules, dead ends, and endpoints no command wraps yet.

## License

MIT. See [LICENSE](LICENSE).
