# Setup

Pre-reqs you do once. Most are clickthrough in DSM; the only command-line work is the final container build.

## 1. DSM packages

In DSM → Package Center, install:

- **Container Manager** (Synology's Docker frontend).
- **Tailscale** (official Synology package). Sign in to your tailnet. On DSM the package runs userspace-networking (there is no kernel `tailscale0` interface), so the MCP daemon binds **loopback** and is reached over the tailnet via `tailscale serve` — see "Network model" below.

## 2. Dedicated DSM user

DSM → Control Panel → User & Group → Create.

| Setting | Value |
|---|---|
| Username | `claude-mcp` |
| Description | "MCP server account" |
| Email | (leave blank) |
| Password | strong random (DSM's "Generate Random Password"); store it in your password manager — you'll copy it into a secret file/env (§3) |
| Disallow password change | yes |
| Password never expires | yes |
| Application permissions (wizard) | Allow DSM **and File Station** (the deploy syncs the compose + provisions the project dir via the File Station API). Deny AFP/FTP/SFTP/SMB/rsync/Audio Station you don't use — but see the note below: these denials don't actually bind an `administrators` member. |
| Shared folder permissions | Set No Access if you like, but be aware it isn't effective for an admin (below). |
| User group | `users` **and** `administrators` (see "Why administrators" below) |
| 2-Factor Authentication | enable; capture the TOTP **secret** (base32 string, not the 6-digit code) — you'll need it for the daemon's credentials (§3) |
| Speed limit | leave default |

### Why `administrators`

DSM 7's admin apps — Package Center, Security Advisor, Control Panel, Resource Monitor — and their corresponding APIs (`SYNO.Core.Package.*`, `SYNO.SecurityAdvisor.*`, etc.) are gated by `administrators` group membership. There is no built-in mechanism to grant a non-admin user selective access to those apps; DSM's "Application Privileges" page (Control Panel → Application Privileges) lists only end-user services like File Station / SMB / AFP, not the admin apps.

So the user has to be an admin. To bound the blast radius:

1. **Password never typed by hand.** Generate it via DSM's "Generate Random Password" button and store it in your password manager; it reaches the daemon only through a secret file/env (§3). There is no manual-login workflow for this account.
2. **2FA TOTP enforced.** Even with the password, no DSM (or SSH) login without the TOTP code.
3. **Disable SSH globally** unless you actively need it: Control Panel → Terminal & SNMP → uncheck "Enable SSH service." Admin group implies SSH eligibility; if the service is off, no one can use it.
4. **Tailscale ACL** restricts the MCP port (and 5001/22 if you leave them on) to your own tailnet devices.
5. **Bearer token + Origin check** on the MCP endpoint itself — an attacker who somehow got a DSM SID still can't drive :8765 without the wire token.

**Honest limitation (verified live):** the "deny file protocols / no shared-folder access" controls above do **not** actually bind an `administrators`-group member — DSM's Application Privileges and share ACLs are overridden by admin membership, so `claude-mcp` has full File Station read/write to every share (which is *why* the deploy can provision over the File Station API). So whoever holds this account's password+TOTP has full NAS filesystem access, not just MCP tool access. The load-bearing controls are the real ones: **password never typed (kept in your password manager), 2FA TOTP, SSH off, Tailscale ACL, and the bearer+Origin gate.** Residual risk: full DSM compromise if your credential store leaks AND a Tailscale device key leaks (AND SSH is on). Acceptable for personal use; know what's actually holding the line.

## 3. Credentials

The server reads three secrets — the DSM **password**, the TOTP **seed** (the raw
base32 string DSM showed when you enabled 2FA, not a 6-digit code), and a wire
**bearer** (`openssl rand -hex 32`) — from the environment. Each resolves from the
first source that provides it:

1. **`<NAME>_FILE`** — read the secret from that file path (the Docker `*_FILE` convention). **The default.** The value never enters the container environment, so it's invisible to `docker inspect`, `/proc/<pid>/environ`, and child processes. It does sit on the NAS disk at rest (see the honest tradeoff below).
2. **`<NAME>`** — the secret value directly in an env var. Simplest, but the **weakest**: it lands in the Container Manager project config on disk *and* every env-inspection surface above.

**How you populate those is your call** — write the files, set the env directly, or
fill the env at launch with your own secret manager (`op run`, sops, a Vault agent).
The server ships **no secret-manager client**. Keep the master copy of the password +
TOTP seed wherever you like (a password manager is a fine home); you copy them into a
secret file or env from there.

The variables (both NAS `DSM_*` and, if you run a router, `SRM_*`):

| Secret | Direct env | File form |
|---|---|---|
| DSM password | `DSM_PASSWORD` | `DSM_PASSWORD_FILE` |
| DSM TOTP seed | `DSM_TOTP_SECRET` | `DSM_TOTP_SECRET_FILE` |
| Wire bearer | `MCP_BEARER_TOKEN` | `MCP_BEARER_TOKEN_FILE` |
| Router password / TOTP | `SRM_PASSWORD` / `SRM_TOTP_SECRET` | `SRM_PASSWORD_FILE` / `SRM_TOTP_SECRET_FILE` |

Setting both a `<NAME>` and its `<NAME>_FILE` is refused at boot (ambiguous). File contents are trimmed, so a trailing newline (`printf '%s' secret > file` avoids one; `echo` adds one, which is stripped anyway).

**Setup — upload three files.** This is the shipped default (`synology.compose.yml`), so there's nothing to configure — it already points `DSM_*_FILE` / `MCP_BEARER_TOKEN_FILE` at `/secrets/*` and mounts `./secrets` **read-only**:

1. In **File Station**, create `/docker/synology-mcp/secrets/` and upload three files into it — `dsm_password`, `dsm_totp`, `mcp_bearer` (`openssl rand -hex 32` for the bearer). **Any mode is fine** (File Station lands them `755`) — see below.
2. `npm run deploy` (or create the project — see §6).

That's it — no SSH, no `chmod`, no Task Scheduler. **Rotation:** replace a file in File Station → restart the container.

**Why `755` is fine.** The daemon runs as **root** and reads the files regardless of mode. The only *other* readers are DSM **admins** (who read them at any mode — admin File Station isn't bound by ACLs) and **non-admins** (blocked at the `docker` shared folder's admin-only ACL, with SSH off per §2). So the file mode buys nothing the share ACL doesn't already give you, which is why there's no boot-time chmod and the mount is read-only. Want belt-and-suspenders anyway? Place them `root:root 0600` yourself over SSH (`sudo install -d -m 700 …/secrets && sudo chmod 600 …/secrets/*`) — §2 suggests SSH off, so this is the enable-briefly path.

**Honest tradeoff.** A bind-mounted file sits **on the NAS disk at rest**. A *RAM-only* secret without an external store is **not achievable unattended on Synology**: there's no TPM to anchor an unwrapping key, and a DSM Boot-up task seeds tmpfs only on a full host reboot (not on `npm run deploy` or a crash-restart). So a bind-mounted file is the realistic floor. For off-disk secrets, set `DSM_PASSWORD` / `DSM_TOTP_SECRET` / `MCP_BEARER_TOKEN` in the compose `environment:` and populate them at launch from an external fetcher (`op run`, sops) — a self-managed path (`npm run deploy` re-syncs the shipped `*_FILE` compose, so drive it via the Container Manager UI or your own compose).

## 4. Tailscale ACL

In the Tailscale admin console → Access Controls, restrict TCP :8765 on the NAS so only your Mac(s) and phone can hit it:

```jsonc
"acls": [
  // ... your existing rules ...
  {
    "action": "accept",
    "src":    ["<your-user-tag-or-email>"],
    "dst":    ["nas.local:8765"]
  }
]
```

If your tailnet uses the default open ACL ("everyone can talk to everyone"), add a `tag:nas` and restrict `*` → `tag:nas:*` so only your devices reach the NAS.

### Network model: loopback bind + `tailscale serve`

The daemon binds **loopback only** (`127.0.0.1:8765`) and is reached over the tailnet via the host's Tailscale `serve` proxy. This closes the LAN at the socket layer: a device on your home network gets connection-refused on `:8765` because nothing is bound to the NAS's LAN IP. The only thing that can reach the daemon is the host `tailscaled` (the daemon is on loopback), and it only accepts tailnet traffic. The bearer token + Origin check still run behind serve, so the controls stack: tailnet membership → serve → bearer → Origin.

Set up:

1. In the NAS `.env` (step 6), set `MCP_BIND_HOST=127.0.0.1`.
2. On the NAS, point Tailscale `serve` at the daemon — one-time; it persists in tailscaled state across reboots:

   ```sh
   sudo tailscale serve --bg --https=443 http://127.0.0.1:8765
   ```

   Requires HTTPS certificates enabled for your tailnet (admin console → DNS → Enable HTTPS) — **not** Funnel, which is public-internet ingress; leave it off. Confirm with `tailscale serve status` (and `tailscale funnel status`): both should read `(tailnet only)`.

Clients then use the serve URL `https://<your-nas>.<your-tailnet>.ts.net/mcp` (real cert, HTTPS) instead of `http://<nas>:8765/mcp`.

Why this rather than binding the tailnet IP directly: in userspace-networking mode there is no `tailscale0` to bind — but that same mode forwards inbound tailnet connections to localhost, so both `tailscale serve` (`:443`) and the tailnet IP on `:8765` reach the loopback daemon, while the LAN cannot reach either.

## 5. Optional but useful: DSM notification email

DSM → Control Panel → Notification → Email — point at your Gmail account. When packages have updates, DSM emails you. Set up a Gmail filter to label those messages (e.g., `synology/updates`) so Claude can find them via the Gmail MCP tools.

## 6. Container deploy (Project mode, recommended)

Use Container Manager's **Project** feature, not Container. Project mode reads
`docker-compose.yml` + `.env` from a directory on the NAS, so upgrades are
"swap the image and click Rebuild" — env vars persist on disk.

### One-time setup

1. Build the image locally on your Mac with Apple `container` + `skopeo` (cross-build to linux/amd64 for x86_64 Synology models; use `linux/arm64` on ARM models). DSM's Container Manager imports a docker-archive, so `skopeo` converts the OCI archive `container` produces:

   ```sh
   cd <repo>
   container build --platform linux/amd64 -t synology-mcp:latest .
   container image save --platform linux/amd64 synology-mcp:latest -o /tmp/oci.tar
   skopeo copy --override-os linux --override-arch amd64 \
     oci-archive:/tmp/oci.tar \
     docker-archive:~/Downloads/synology-mcp-latest.tar:synology-mcp:latest
   ```

   Needs `brew install container skopeo` (Colima/Docker are no longer used). **Gotcha:** skopeo writes the RepoTag fully-qualified (`docker.io/library/synology-mcp:latest`) in the archive's `manifest.json` + legacy `repositories` file; DSM imports that as a *distinct* image and never reassigns the bare `synology-mcp:latest` tag the Compose project pulls — so the container silently keeps the old image. Rewrite the RepoTags to the bare name before importing (extract → edit `manifest.json`/`repositories` → re-tar).

2. Prepare the NAS directory (the one manual step). DSM → File Station → `/volume1/docker/`. Create folder `synology-mcp`, and inside it `secrets/` (the `audit/` dir is created automatically — Docker's bind mount makes it `root:root` on first start, which the capability-dropped root daemon can write). Upload the three credential files into `secrets/` — `dsm_password`, `dsm_totp`, `mcp_bearer` (any mode; the mount is read-only and the `docker` share is admin-gated). No `.env` and no compose upload needed — `npm run deploy` syncs the compose and creates the project.
   - *(Want the secrets RAM-only instead of files? Set `DSM_PASSWORD` / `DSM_TOTP_SECRET` / `MCP_BEARER_TOKEN` in the compose `environment:` at launch from your own fetcher — see §3.)*

3. `npm run deploy` from the repo on your Mac. It imports the image tar, syncs `synology.compose.yml`, **creates the Container Manager project if it doesn't exist** (else updates it), does a quiet stop→build→start, and polls `/health`. See "Upgrades" below for the credential env it needs. No Container Manager UI clicks.
   - *(Prefer the UI for first creation? Container Manager → Image → Add from file (the tar) → Project → Create → path `/volume1/docker/synology-mcp` → "Use existing docker-compose.yml". Then `npm run deploy` handles all future updates.)*

### Upgrades

```sh
container build --platform linux/amd64 -t synology-mcp:<ver> .
container image save --platform linux/amd64 synology-mcp:<ver> -o /tmp/oci.tar
skopeo copy --override-os linux --override-arch amd64 \
  oci-archive:/tmp/oci.tar \
  docker-archive:~/Downloads/synology-mcp-<ver>.tar:synology-mcp:latest
# then rewrite the archive's RepoTags to the bare `synology-mcp` name (see the build gotcha above)
source dev/source-creds.sh   # once per shell; exports DSM_PASSWORD/DSM_TOTP_SECRET for the deploy
npm run deploy                # imports image → recreates project → polls /health
```

Total wall time on Tailscale: ~30 seconds, most of it the 60 MB tar upload.

`npm run deploy` walks the DSM Web API end-to-end:

1. POST the tar to `/webapi/entry.cgi/SYNO.Docker.Image?api=…&method=upload&version=1` (the chunked-upload URL pattern the Container Manager UI uses; multipart-form field name is `filename`, X-SYNO-TOKEN header required). DSM imports the tar straight into its local Docker registry — no FileStation, no on-disk staging, no shared-folder ACL involved.
2. `SYNO.Docker.Project.list` to look up the project UUID by name.
3. `SYNO.Docker.Project.stop` → `Project.build` → `Project.start` to recycle the container with the freshly-imported `:latest`.
4. Poll `/health` until the response body's `version` matches `package.json`'s (bails after 120 seconds). Defaults to `http://<nas>:8765/health`; with the loopback + serve model, set `MCP_HEALTH_URL=https://<your-nas>.<your-tailnet>.ts.net/health` (e.g. in `dev/.env.local`) so the poll goes through serve instead of the now-closed direct port.

Exits non-zero on any step failure with a precise reason. No additional DSM permissions are required beyond what claude-mcp already has (administrators group, which it joined during setup).

To use a separate admin identity for deploys (e.g. keep claude-mcp's runtime token completely separate from deploy auth), set `DSM_DEPLOY_USER`, `DSM_DEPLOY_PASSWORD`, and `DSM_DEPLOY_TOTP_SECRET` env vars before `npm run deploy`.

Manual fallback (no script needed): import the tar via Container Manager UI → click Project → Action → Build. Same outcome, six clicks instead of one command.

## 7. Verify

From a Mac on the tailnet, hit the serve URL (use the bearer you generated for `mcp_bearer`):

```sh
TOKEN=<your bearer token>   # the value you put in mcp_bearer
curl -i https://<your-nas>.<your-tailnet>.ts.net/health
# expect: 200 OK {"ok":true,"server":"synology-mcp","version":"..."}

curl -i -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
     https://<your-nas>.<your-tailnet>.ts.net/mcp
# expect: a tools list including nas_status, nas_packages_list, ...
```

Confirm the LAN is closed: from a device that can reach the NAS's LAN IP, `curl http://<nas-lan-ip>:8765/health` should be **connection-refused** — the daemon binds no LAN-facing socket. (`http://<nas>:8765` over the *tailnet* still works — tailscaled forwards it to the loopback daemon — and is bearer-gated like serve.) A tailnet device not in the ACL allowlist is blocked at the ACL layer.

## 8. Local bridge (Claude Desktop only)

**Claude Code users skip this** — Code connects over HTTP (§9). Claude Desktop's config only accepts **stdio** servers, so it needs a local `bridge` (a tiny stdio→HTTP proxy shipped in this package):

```sh
cd <repo>
npm install -g .            # no Homebrew formula; installs to your npm global prefix
command -v synology-mcp     # note this path for §9's "command"
```

Re-run `npm install -g .` after code changes (it's a stable snapshot — repo edits don't propagate until you do).

## 9. Wire up Claude

**Claude Desktop** — add under `mcpServers` in `claude_desktop_config.json` (`command` = the §8 path):

```json
"synology": {
  "command": "/opt/homebrew/bin/synology-mcp",
  "args": ["bridge"],
  "env": {
    "MCP_BRIDGE_URL": "https://<your-nas>.<your-tailnet>.ts.net/mcp",
    "MCP_BRIDGE_TOKEN": "<bearer token>"
  }
}
```

**Claude Code** — native HTTP, no bridge (`--transport http` is required; the default is stdio):

```sh
TOKEN=<your bearer token>   # the value you put in mcp_bearer
claude mcp add --transport http synology https://<your-nas>.<your-tailnet>.ts.net/mcp \
  --header "Authorization: Bearer $TOKEN"
```

Restart the client; `mcp__synology__*` tools appear.

## Uninstall, in reverse

To remove the integration completely:

1. Remove the `synology` entry from `claude_desktop_config.json` and any Claude Code MCP registration (`claude mcp remove synology`).
2. Container Manager → stop + delete the `synology-mcp` project.
3. `rm -rf /volume1/docker/synology-mcp` (this deletes the audit log too — copy it out first if you want to keep it).
4. Tailscale ACL → remove the `:8765` rule you added.
5. DSM → Control Panel → User & Group → delete `claude-mcp`.
6. Delete the account's password + TOTP seed + bearer from wherever you stored them.
