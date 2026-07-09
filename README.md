# synology-mcp

MCP server for managing a Synology NAS (DSM 7). Exposes typed tools for package management, security audit, share inspection, and storage health. Designed to run as a container on the NAS itself, reachable from your Mac over Tailscale.

## What it does

- Read tools (safe to invoke): system status, storage/drive health, installed packages, available updates, package info, Security Advisor findings, users + 2FA state, firewall, DSM security settings, shares, external access (QuickConnect / DDNS / reverse proxy), certificates, notifications.
- Write tools (gated on user confirmation): install / uninstall / update a single package, plus start/stop/restart. Refuses DSM-self updates and kernel-flagged packages.
- Per-write audit log written to `/volume1/docker/synology-mcp/audit/YYYY-MM.jsonl`.

## What it does *not* do

- DSM self-update, firewall rule edits, 2FA policy changes, SMB protocol changes. These appear only as findings; apply manually via the DSM UI.

## Before you install

This server:
- Talks to DSM's Web API as a dedicated DSM user `claude-mcp` (must be in `administrators` because DSM 7 gates its admin APIs on that group; 2FA TOTP enforced, no SSH service — an admin has File Station/share access regardless, so the load-bearing controls are 2FA + no-SSH + Tailscale + bearer; see `docs/SETUP.md`).
- Reads its credentials at startup from bind-mounted `*_FILE` secret files or direct env vars — no built-in secret-manager dependency (populate them however you like: a file, env, or `op run` / sops at launch).
- Binds its HTTP endpoint to the `tailscale0` interface only — not LAN-reachable.
- Logs every mutating call to a local JSONL audit file.

## Install

One command from your Mac (the container runs on the NAS):

```sh
npx synology-mcp install --nas https://<nas>:5001
```

It prompts (no-echo) for the DSM `claude-mcp` password + TOTP **seed** — or reads them from `DSM_PASSWORD`/`DSM_TOTP_SECRET` — **validates them with a live login**, generates the wire bearer, and provisions everything over the DSM API (secret files streamed via stdin, compose, image, project), then prints the `claude mcp add` line. No File Station clicks, no SSH.

- **Using a secret manager?** Run it under `op run` (or the equivalent) so the plaintext stays in RAM — e.g. `op run -- npx synology-mcp install --nas https://<nas>:5001` with `DSM_PASSWORD`/`DSM_TOTP_SECRET` set to `op://…` refs.
- `--tar <path>` — use a locally built image tar instead of downloading the release asset (offline / maintainer builds).
- `synology-mcp update` — pull a newer version to an existing install. Re-auths the same way (env or prompt; needs only password + TOTP, no bearer).

> **Run install from a trusted network** — the NAS's LAN, or over Tailscale. DSM ships a self-signed cert, so the installer skips TLS verification for the NAS and can't detect a man-in-the-middle; it transmits the DSM password + TOTP **seed** to the NAS during install, so on a hostile network an active MITM could capture durable admin credentials. (The downloaded image itself is fetched from GitHub over verified TLS and checked against a published sha256.) Re-running `install` mints a **new** bearer — already-wired clients keep working only after you update their header; use `update` to ship a new image without rotating the bearer.

One-time DSM UI prereq: install Container Manager + Tailscale from Package Center and create the `claude-mcp` admin user with 2FA (DSM's API can't enroll 2FA). Full setup and the credential options are in [`docs/SETUP.md`](docs/SETUP.md).

## Footprint

| What | Where |
|---|---|
| Container image | DSM Container Manager, project `synology-mcp` |
| Container network | host networking; binds to tailscale0 only |
| HTTP port | 8765 (configurable) |
| Audit log | `/volume1/docker/synology-mcp/audit/YYYY-MM.jsonl` |
| DSM user | `claude-mcp` (admin group, 2FA; admins have File Station/share access regardless) |
| Secrets | bind-mounted `*_FILE` secret files, or direct env vars |
| Outbound | localhost:5001 (DSM API); plus the SRM router's URL when a router target is configured |

## License

MIT. See [LICENSE](LICENSE).
