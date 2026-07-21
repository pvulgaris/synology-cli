# synology-cli

`syno`, a command-line tool for a Synology NAS (DSM 7) and, optionally, an SRM router. Packages, security audit, shares and snapshots, backups, storage health, and a raw escape hatch to any DSM Web API endpoint.

Every command prints JSON on stdout, so you can pipe it straight to `jq`. The DSM call trace goes to stderr. Exit 0 on success, 1 on failure, 2 on a usage error.

## Install

```sh
npm install -g .
syno --help
```

That puts `syno` on your `PATH`. Node 22 or newer.

## Configure

Required:

| Env | Meaning |
|---|---|
| `DSM_BASE_URL` | e.g. `https://nas.local:5001` |
| `DSM_USER` | DSM account name (default `claude-mcp`) |
| `DSM_PASSWORD` | account password |
| `DSM_TOTP_SECRET` | TOTP seed for the account's 2FA |

The account must be in the `administrators` group. DSM 7 gates its admin APIs on that membership and offers no selective grant.

Every secret also accepts a `*_FILE` form (`DSM_PASSWORD_FILE`, `DSM_TOTP_SECRET_FILE`) naming a file to read it from. Setting both forms of the same secret is refused. Symlinks are refused. How the value gets there is up to you: a 0600 file, a plain export, or a launcher like `op run` or sops. There's no built-in secret-manager dependency.

Optional:

| Env | Meaning |
|---|---|
| `SRM_BASE_URL` | e.g. `https://router.local:8001`. Presence alone enables the router commands. |
| `SRM_USER`, `SRM_PASSWORD`, `SRM_TOTP_SECRET` | router login (also `*_FILE`). Must be an SRM admin; usage is read-only. |
| `AUDIT_LOG_DIR` | where write operations are logged. Default `~/.local/state/syno/audit/`. |
| `TLS_REJECT_UNAUTHORIZED` | anything but `0` enforces cert validation. Defaults to skipping, since DSM ships a self-signed cert. |

The DSM session is cached under `~/.local/state/syno/` so back-to-back invocations don't each burn a login and a 2FA code.

## Commands

Writes are marked. `syno --help` prints the same list.

| Command | What it does |
|---|---|
| `syno status` | model, DSM version, uptime, temperature, CPU/memory load |
| `syno storage` | volumes (status, used/free, RAID level) and drives (S.M.A.R.T., temp, model) |
| `syno shares list` | shared folders with encryption, quota, recycle bin, snapshot support |
| `syno shares snapshots <share>` | Btrfs snapshots for one share, with immutable/WORM lock state |
| `syno shares snapshot-config <share>` | snapshot task config: schedule and Smart Recycle retention |
| `syno backup tasks` | Hyper Backup tasks: destination, encryption, schedule, last result |
| `syno tasks list` | DSM Task Scheduler entries |
| `syno packages list` | installed packages with versions and running state |
| `syno packages updates` | packages with pending updates from the Synology repo |
| `syno packages info <name>` | publisher, description, changelog, dependencies, size |
| `syno packages install <name>` | **write.** `[--version=X] [--accept-dependencies]` |
| `syno packages update <name>` | **write.** update to the latest version |
| `syno packages uninstall <name>` | **write.** requires `--keep-data`; data deletion isn't supported here |
| `syno packages control <name> <start\|stop\|restart>` | **write.** idempotent, verified by status poll |
| `syno security scan` | runs DSM Security Advisor and returns the failing rules |
| `syno security settings` | web/TLS, SSH, SMB, NFS, auto-update, password policy, telemetry |
| `syno security firewall` | firewall profiles, auto-block, per-adapter DoS protection |
| `syno users list` | accounts: name, uid, 2FA state, expired flag, email |
| `syno external` | QuickConnect, DDNS, App Portal, reverse proxy, port forwarding |
| `syno notifications` | SMTP config: server, port, SSL, verify-cert, sender, recipient count |
| `syno certificates` | certificates with derived `days_until_expiry` |
| `syno updates` | pending updates across DSM OS, NAS packages, router OS, router packages |
| `syno dsm update-check` | whether a DSM OS update is available (detect only) |
| `syno router update-check` | whether an SRM router OS update is available (detect only) |
| `syno raw <api> <method>` | any DSM endpoint. `[--version=N] [--post] [k=v ...]` |

## Writes require `--yes`

Any command marked **write** refuses to run without `--yes`. So does `syno raw --post`, since DSM treats POST as mutating.

```sh
syno packages update SynologyDrive --yes
```

Nothing prompts you. The flag is the confirmation.

Two hard refusals: updating DSM itself and updating kernel-flagged packages. Apply those through the DSM UI. Firewall rule edits, 2FA policy changes, and SMB protocol toggles aren't implemented either; they surface as audit findings only.

Uninstall always preserves package data. Actual data deletion is package-specific and belongs in the DSM UI.

Every write is appended to a monthly JSONL audit log with the before/after state.

## `raw`

For anything without a named command:

```sh
syno raw SYNO.Core.Share get --version=1 name='"docs"'
```

Params are form-encoded and DSM JSON-parses each value, so string params need their quotes on the wire. Bools and numbers are literal; arrays and objects are JSON-stringified. Use `--` to stop flag parsing when a DSM param name collides with a CLI flag.

See [`docs/dsm-api-quirks.md`](docs/dsm-api-quirks.md) for error codes, response shapes, and known API names.

## License

MIT. See [LICENSE](LICENSE).
