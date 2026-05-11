# Notes for future Claude sessions

## DSM endpoint coverage is uneven

`SYNO.*` is not a public, versioned spec — Synology publishes a partial guide (mainly Auth + FileStation), and the rest is reverse-engineered from DSM's own JS clients. When adding a new tool, **inspect DSM's UI network tab** for the exact `api/method/version/params` the official client sends, then mirror those. Don't trust third-party docs alone.

When a method's response shape changes between DSM minor versions, fail open in `tools/*.ts` (use `.catch(() => null)` for optional fields, then surface what we did get). The Security Advisor and DSM Settings APIs are particularly variable.

## SID lifetime

`SID_TTL_MS = 10 * 60 * 1000` in `dsm.ts` is *our* TTL, not DSM's. DSM's actual SID lifetime depends on Control Panel → Security → Logout timer (default 30 min idle). The 10-minute internal refresh is just an optimization; if it expires for real, the `code 117/119` retry path in `call()` handles it transparently.

## Why no synology-api npm dep

There are several `synology-*` npm packages. None covered SYNO.Core.Package, SYNO.SecurityAdvisor.*, and SYNO.Core.Share with the field-level options we need. Rolling our own thin client (~200 lines in `dsm.ts`) was cleaner than wrapping a community lib for partial coverage. Don't add a dep here unless one of them grows into mature coverage.

## Why claude-mcp is in `administrators`

DSM 7's admin APIs (`SYNO.Core.Package.*`, `SYNO.SecurityAdvisor.*`, `SYNO.Core.User.*`, `SYNO.Core.Share`, etc.) gate on `administrators` group membership. There is no selective-grant mechanism for non-admin users — DSM's "Application Privileges" page covers only end-user services (File Station, SMB, AFP, ...). An earlier draft of this repo planned a non-admin claude-mcp user with selective Package Center / Security Advisor access; that plan was wrong about what DSM actually supports.

Compensating controls are documented in docs/SETUP.md ("Why administrators"). The short version: password only in 1Password (never typed), 2FA TOTP enforced, no shared-folder access, no SSH service running, Tailscale ACL restricts ports to your devices, bearer + Origin on the MCP endpoint. Residual risk is acceptable for personal use; don't quietly relax these controls.

## Hard refusals live in `tools/packages.ts`, not in `server.ts`

`HARD_REFUSE_NAMES = new Set(["DSM", "kernel"])`. If you find yourself wanting to add a refusal at the server-registration layer, push it down into the tool function so the JSONL audit log captures the rejected attempt with full args. Server-registration refusals are silent from the audit's perspective.

## Bearer rotation

`mcp_bearer_token` in 1Password is the single source of truth. Rotation = generate new value → update 1Password → restart container (auto-reads on boot) → update `claude_desktop_config.json` on every Mac that points here → restart Claude clients. There is no in-flight rotation path.

## TLS bypass is process-wide

`cli.ts` sets `NODE_TLS_REJECT_UNAUTHORIZED=0` at startup when `cfg.tlsRejectUnauthorized` is false (the default). This affects every outbound fetch in the process. The MCP server only talks to DSM, so the scope is bounded — but if you ever add another HTTP client here, remember that its TLS verification is also off.

## Time Machine state lives on the Mac

The NAS only stores the SMB share config + quota. Backup *state* (last successful, in-progress, errors) is in macOS's `tmutil` on the Mac being backed up. The skill's SKILL.md tells Claude to shell out via Bash when running on that Mac; do not try to add an MCP tool for backup state — it would have to SSH to the Mac, which adds a whole separate auth surface we don't want.

## Deferred (do not pre-build)

These are conscious omissions kept as architectural space, not gaps:

- Firewall rule edits, 2FA enforcement changes, SMB protocol toggles — out of scope; surface as findings only.
- DSM self-update — would brick the connection mid-call.
- Btrfs snapshot helper — YAGNI for v1; users can snapshot via DSM UI if they want pre-mutation insurance.
- Cert inventory, recent-logins, SecAdvisor history — none mapped to a stated user request.
- An `nas_audit_log` read tool — JSONL is on disk; reading it is a file-system op, not an MCP one.

If a future request actually requires one of these, add it then.
