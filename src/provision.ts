/**
 * Auto-deploy a built image tar to the running Container Manager project.
 *
 * From the laptop: `npm run deploy` (or `npx tsx src/dev/runner.ts deploy`).
 * Walks: import the tar directly into DSM's Docker daemon → stop+build+start
 * the Compose project → poll /health until it reports the new version.
 *
 * The image upload uses DSM's chunked-upload URL pattern that the Container
 * Manager web UI uses:
 *   POST /webapi/entry.cgi/SYNO.Docker.Image?api=SYNO.Docker.Image&method=upload&version=1
 *   multipart/form-data; field name="filename" carries the tar body, with the
 *   multipart `filename` attribute set to the basename. X-SYNO-TOKEN header
 *   required.
 * This is NOT documented in the public DSM Web API docs — it was reverse-
 * engineered from a DevTools capture. Don't confuse it with `entry.cgi`'s
 * normal form-encoded API surface.
 *
 * Auth: standard claude-mcp login. The install-or-update flow uses the
 * SYNO.FileStation.* API (CreateFolder/List/Upload) to sync the compose and
 * provision the project dir — claude-mcp is an `administrators`-group account,
 * which has File Station access regardless of the "Application Privileges" page
 * (that denial doesn't bind admins; verified live). Override the deploy identity
 * with DSM_DEPLOY_* env vars for a separate admin account.
 */
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { readFile, mkdtemp, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { authenticator } from "otplib";
import { gatherInstallCredentials, gatherDsmCredentials, type InstallCredentials } from "./creds.js";
import { type Config, envValue } from "./config.js";
import { credsFromPrefix } from "./auth.js";

const execFileP = promisify(execFile);

const PROJECT_NAME_DEFAULT = "synology-mcp";
const HEALTH_PORT_DEFAULT = 8765;
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 120_000;

interface DeployArgs {
  tar: string;
  /** Internal (dev `npm run deploy`); no user-facing flag. Defaults to synology-mcp. */
  project?: string;
}

interface DeployResult {
  imageImported: boolean;
  projectId: string;
  healthVersion: string;
}

function log(...args: unknown[]) {
  console.error("[deploy]", ...args);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Log in to DSM with explicit credentials and return the API session. Also the
 *  install path's credential *validation* — a wrong password / mis-copied TOTP
 *  seed fails here, before anything is pushed to the NAS. */
export async function loginWithCreds(
  cfg: Config,
  user: string,
  password: string,
  totpSecret: string
): Promise<{ sid: string; synotoken: string; user: string }> {
  const totp = authenticator.generate(totpSecret);
  // POST with credentials in the form BODY, never the URL query string — so the
  // password + live TOTP can't be captured by a proxy / DSM access log that records
  // request URLs. TLS to DSM's self-signed cert is still skipped process-wide (see
  // runInstall); that blast radius is this DSM host only.
  const form = new URLSearchParams({
    api: "SYNO.API.Auth",
    version: "6",
    method: "login",
    account: user,
    passwd: password,
    otp_code: totp,
    format: "sid",
    session: "synology-mcp-deploy",
    enable_syno_token: "yes",
  });
  const res = await fetch(`${cfg.baseUrl}/webapi/entry.cgi`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form,
  });
  const body = (await res.json()) as any;
  if (!body?.success) {
    const code = body?.error?.code ?? -1;
    throw new Error(
      `DSM login failed for ${user} (code ${code}). Check the password + TOTP seed ` +
        `(${code === 400 || code === 404 ? "code 400/404 = wrong password or TOTP" : "see docs/dsm-api-quirks.md"}).`
    );
  }
  return { sid: body.data.sid, synotoken: body.data.synotoken ?? "", user };
}

/** Best-effort: invalidate the deploy SID so a session token that was briefly on
 *  curl's argv (visible via `ps` during the run) is dead the moment we finish. */
async function logout(cfg: Config, auth: { sid: string; synotoken: string }): Promise<void> {
  await dsmCallWithToken(cfg, auth, {
    api: "SYNO.API.Auth",
    method: "logout",
    version: 6,
    params: { session: "synology-mcp-deploy" },
  }).catch(() => {
    /* best-effort — a lingering SID expires on its own */
  });
}

async function loginForDeploy(
  cfg: Config
): Promise<{ sid: string; synotoken: string; user: string }> {
  // Deploy/update need only password + TOTP (no bearer — that lives on the NAS). An
  // explicit DSM_DEPLOY_* pair (env or *_FILE) wins; else gatherDsmCredentials resolves
  // the DSM_* login secrets (env/*_FILE) or a no-echo prompt (the flagship prompt-install
  // Mac). credsFromPrefix fails loud on a half-set/misconfigured pair — it never silently
  // mixes a DSM_DEPLOY_USER with the runtime password, and a prompt can't mask a real
  // error. op users run `op run -- synology-mcp update`.
  const user = envValue("DSM_DEPLOY_USER") ?? cfg.user;
  const { password, totpSecret } = credsFromPrefix("DSM_DEPLOY") ?? (await gatherDsmCredentials());
  return loginWithCreds(cfg, user, password, totpSecret);
}

/** Build curl args common to every deploy call: silent + optional TLS skip.
 *  `-k` is gated on `cfg.tlsSkipVerify` so dev shells trusting DSM's
 *  self-signed cert (the default) still work, while a future caller that
 *  imports a real cert into the system trust store gets verification. */
function curlBase(cfg: Config): string[] {
  const args = ["-s"];
  if (cfg.tlsSkipVerify) args.push("-k");
  return args;
}

/** Run curl and return stdout, but on failure throw WITHOUT the argv. Node's
 *  execFile rejection message embeds the full command line, which for these DSM
 *  calls carries the session `_sid` + `SynoToken`; letting it propagate would
 *  print a live admin session token into terminal scrollback / CI logs. */
async function runCurl(
  args: string[],
  opts: { maxBuffer: number },
  label: string
): Promise<string> {
  try {
    const { stdout } = await execFileP("curl", args, opts);
    return stdout;
  } catch (err: any) {
    throw new Error(`${label}: curl failed (${err?.code ?? err?.signal ?? "error"})`);
  }
}

/** Upload + import the image tar in one shot via the chunked-upload URL the
 *  DSM Container Manager UI uses. Streams via curl — Node fetch chokes on
 *  multipart bodies past ~16MB (silently produces a body its undici impl
 *  can't stream cleanly), while curl handles it. */
async function uploadImage(
  cfg: Config,
  auth: { sid: string; synotoken: string; user: string },
  tarPath: string
): Promise<void> {
  const st = await stat(tarPath);
  const filename = basename(tarPath);
  // The Container Manager UI uses an undocumented chunked-upload URL pattern:
  // the API name appears as a path segment after entry.cgi. The form field
  // carrying the file body is also named `filename` (DSM reuses that string
  // for both the form-data `name` and the multipart `filename` attribute).
  const url = `${cfg.baseUrl}/webapi/entry.cgi/SYNO.Docker.Image?api=SYNO.Docker.Image&method=upload&version=1`;
  log(`uploading + importing ${filename} (${(st.size / 1024 / 1024).toFixed(1)} MB)…`);
  const args = [
    ...curlBase(cfg),
    "-X",
    "POST",
    url,
    "-H",
    `X-SYNO-TOKEN: ${auth.synotoken}`,
    "-H",
    `Cookie: id=${auth.sid}`,
    "-F",
    `filename=@${tarPath};filename=${filename}`,
  ];
  const stdout = await runCurl(args, { maxBuffer: 4 * 1024 * 1024 }, "Image.upload");
  let body: any;
  try {
    body = JSON.parse(stdout);
  } catch {
    throw new Error(`Image.upload returned non-JSON: ${stdout.slice(0, 200)}`);
  }
  if (!body?.success) {
    throw new Error(`Image.upload failed (code ${body?.error?.code}): ${stdout.slice(0, 400)}`);
  }
  log(`image imported`);
}

/** entry.cgi URL carrying the deploy session (SID + SynoToken) as query params —
 *  the auth every File Station / Docker.* curl call needs. `params` (api, method,
 *  version, …) ride the query too; JSON calls pass the rest as curl form fields. */
function entryUrl(
  cfg: Config,
  auth: { sid: string; synotoken: string },
  params: Record<string, string> = {}
): string {
  const url = new URL(`${cfg.baseUrl}/webapi/entry.cgi`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("_sid", auth.sid);
  if (auth.synotoken) url.searchParams.set("SynoToken", auth.synotoken);
  return url.toString();
}

/** Run a DSM Web API call with SynoToken via curl. DSM gates mutating
 *  endpoints (Image.upload, Project.{stop,start,build}) on the CSRF token
 *  even when the SID is valid; without it you get a misleading code 119
 *  "SID not found". curl is also easier than coercing a fresh SynoClient to
 *  thread the token through. */
async function dsmCallWithToken<T = any>(
  cfg: Config,
  auth: { sid: string; synotoken: string },
  opts: { api: string; method: string; version: number; params?: Record<string, string> }
): Promise<T> {
  const args: string[] = [...curlBase(cfg), "-X", "POST", entryUrl(cfg, auth)];
  const dataPairs: Record<string, string> = {
    api: opts.api,
    version: String(opts.version),
    method: opts.method,
    ...(opts.params ?? {}),
  };
  for (const [k, v] of Object.entries(dataPairs)) {
    args.push("--data-urlencode", `${k}=${v}`);
  }
  if (auth.synotoken) args.push("-H", `X-SYNO-TOKEN: ${auth.synotoken}`);
  console.error(`[dsm-curl] → ${opts.api}.${opts.method}`, opts.params ?? {});
  const stdout = await runCurl(args, { maxBuffer: 16 * 1024 * 1024 }, `${opts.api}.${opts.method}`);
  let body: any;
  try {
    body = JSON.parse(stdout);
  } catch {
    throw new Error(`${opts.api}.${opts.method} returned non-JSON: ${stdout.slice(0, 200)}`);
  }
  if (!body?.success) {
    throw new Error(
      `${opts.api}.${opts.method} failed (code ${body?.error?.code}): ${JSON.stringify(body.error)}`
    );
  }
  console.error(`[dsm-curl] ✓ ${opts.api}.${opts.method}`);
  return body.data as T;
}

/** Look up the Compose project by name. Returns id + current status, or null when
 *  it doesn't exist yet (first install — the caller then creates it). */
async function findProject(
  cfg: Config,
  auth: { sid: string; synotoken: string },
  projectName: string
): Promise<{ id: string; status: string } | null> {
  const list = await dsmCallWithToken<any>(cfg, auth, {
    api: "SYNO.Docker.Project",
    method: "list",
    version: 1,
  });
  if (!list || typeof list !== "object") {
    throw new Error(`Project.list returned unexpected shape: ${JSON.stringify(list)}`);
  }
  const entries: Array<{ id: string; name: string; status: string }> = Object.values(
    list
  ).map((v: any) => ({ id: v.id, name: v.name, status: v.status }));
  const match = entries.find((e) => e.name === projectName);
  if (!match) return null;
  log(`project ${projectName} → uuid=${match.id} status=${match.status}`);
  return { id: match.id, status: match.status };
}

/** The repo's canonical compose, synced to the NAS project dir on every deploy so
 *  compose changes ship with the tool (the operator never hand-edits it). */
async function repoComposeContent(): Promise<string> {
  return readFile(
    join(fileURLToPath(import.meta.url), "..", "..", "synology.compose.yml"),
    "utf8"
  );
}

/** Ensure /docker/<projectName> exists (idempotent — ignore "already exists"). */
async function ensureProjectDir(
  cfg: Config,
  auth: { sid: string; synotoken: string },
  projectName: string
): Promise<void> {
  await dsmCallWithToken(cfg, auth, {
    api: "SYNO.FileStation.CreateFolder",
    method: "create",
    version: 2,
    params: { folder_path: "/docker", name: projectName, force_parent: "true" },
  }).catch((e: any) => {
    // Usually just "already exists" — fine. Surface anything else (permission / share
    // error) so it isn't silent; a real failure still resurfaces at the create/upload
    // below, but with a clear breadcrumb here.
    log(`CreateFolder ${projectName}: ${e?.message ?? e} (continuing)`);
  });
}

/** Upload a small text file into a File Station folder (create_parents + overwrite).
 *  curl -F like uploadImage; content rides a temp file. */
async function uploadText(
  cfg: Config,
  auth: { sid: string; synotoken: string },
  folderPath: string,
  filename: string,
  content: string
): Promise<void> {
  // Stream the body via curl's stdin (file=@-), so secret content never lands in a
  // temp file on the deploying Mac. This is the install path's guarantee: no
  // plaintext at rest locally.
  const url = entryUrl(cfg, auth, {
    api: "SYNO.FileStation.Upload",
    version: "2",
    method: "upload",
  });
  const args = [
    ...curlBase(cfg),
    "-X", "POST", url,
    "-H", `X-SYNO-TOKEN: ${auth.synotoken}`,
    "-F", `path=${folderPath}`,
    "-F", "create_parents=true",
    "-F", "overwrite=true",
    "-F", `file=@-;filename=${filename}`,
  ];
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn("curl", args);
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve(out) : reject(new Error(`curl exited ${code}: ${err.slice(0, 200)}`))
    );
    child.stdin.on("error", () => {}); // ignore EPIPE if curl exits before we finish writing
    child.stdin.end(content);
  });
  let body: any;
  try {
    body = JSON.parse(stdout);
  } catch {
    throw new Error(`FileStation.Upload returned non-JSON: ${stdout.slice(0, 200)}`);
  }
  if (!body?.success) {
    throw new Error(`FileStation.Upload ${filename} failed (code ${body?.error?.code})`);
  }
}

/** The compose filename the project dir already uses, so an update overwrites the
 *  single existing file rather than adding a second one (two compose files jam
 *  Container Manager's worker — hard-won). We don't pick the name — DSM's
 *  Project.create writes the compose and names it — so match ANY single YAML rather
 *  than a fixed list. Errors if more than one is present. */
async function existingComposeName(
  cfg: Config,
  auth: { sid: string; synotoken: string },
  dir: string
): Promise<string> {
  // A real list error propagates (aborts the deploy) — guessing on a transient
  // failure could upload a SECOND compose file, which jams the compose worker.
  const listing = await dsmCallWithToken<any>(cfg, auth, {
    api: "SYNO.FileStation.List",
    method: "list",
    version: 2,
    params: { folder_path: dir },
  });
  const names: string[] = (listing?.files ?? []).map((f: any) => f.name);
  // Any single YAML in the project dir IS the compose, whatever CM named it on create.
  const present = names.filter((n) => /\.ya?ml$/i.test(n));
  // >1 is ambiguous — don't guess which one CM uses (overwriting the wrong one leaves
  // stale compose + a second file). Bail.
  if (present.length > 1) {
    throw new Error(
      `project dir has multiple YAML files (${present.join(", ")}); remove the extras so ` +
        `one compose file remains, then redeploy — Container Manager jams on two.`
    );
  }
  // Overwrite the single existing file (whatever its name); default compose.yaml for a
  // fresh/empty dir.
  return present[0] ?? "compose.yaml";
}

/** Create the Compose project from the synced compose (first install). Returns id.
 *  Shape reverse-engineered live: {name, share_path:/docker/<name>, content}. */
async function createProject(
  cfg: Config,
  auth: { sid: string; synotoken: string },
  projectName: string,
  shareDir: string,
  content: string
): Promise<string> {
  const data = await dsmCallWithToken<any>(cfg, auth, {
    api: "SYNO.Docker.Project",
    method: "create",
    version: 1,
    params: { name: projectName, share_path: shareDir, content },
  });
  if (!data?.id) {
    throw new Error(`Project.create returned no id: ${JSON.stringify(data).slice(0, 200)}`);
  }
  log(`created project ${projectName} → uuid=${data.id}`);
  return data.id;
}

/** Recycle the Compose project to pick up the new :latest image, quietly:
 *  stop (if running) → build → start.
 *
 *  Why stop first: DSM's ContainerManager watcher emails a Critical
 *  "Container stopped unexpectedly" (`docker_container_unexpected_exit`)
 *  whenever a *running* container dies without CM having registered the stop as
 *  intentional. `Project.build` recreates-while-running — it kills the live
 *  container at the docker level — which reads as a crash, one email per deploy.
 *  An API-initiated `Project.stop` IS registered as intentional and stays
 *  silent, so stopping first means `build` recreates from cold (no live
 *  container dies, no event). The earlier "skip the stop to avoid the
 *  notification" comment had it exactly backwards — it was never A/B'd. `start`
 *  is unconditional (build from a stopped project doesn't reliably auto-start;
 *  starting an already-up project is a harmless no-op). */
async function rebuildProject(
  cfg: Config,
  auth: { sid: string; synotoken: string },
  projectId: string,
  initialStatus: string
): Promise<void> {
  // Stop unless the project is already definitively stopped. Testing for any
  // live-ish state (RUNNING/STARTING/…) rather than == "RUNNING" so a transitional
  // status still gets the intentional stop — else build recreates a live container
  // and DSM fires "stopped unexpectedly".
  if (!["STOPPED", "CREATED"].includes(initialStatus)) {
    log(`stopping project (CM-registered shutdown — no "stopped unexpectedly" alert)…`);
    await dsmCallWithToken(cfg, auth, {
      api: "SYNO.Docker.Project",
      method: "stop",
      version: 1,
      params: { id: projectId },
    });
  }
  log(`building project (recreates containers from cold with new :latest)…`);
  await dsmCallWithToken(cfg, auth, {
    api: "SYNO.Docker.Project",
    method: "build",
    version: 1,
    params: { id: projectId },
  });
  log(`starting project…`);
  await dsmCallWithToken(cfg, auth, {
    api: "SYNO.Docker.Project",
    method: "start",
    version: 1,
    params: { id: projectId },
  });
}

/** Poll the daemon's /health until it reports the version we just shipped. Returns
 *  the version on success, or `null` if /health was never reachable from here — the
 *  expected case when the daemon binds loopback (see below), NOT a deploy failure.
 *  Throws only when /health answered but never with the expected version. */
async function pollHealth(cfg: Config, expectedVersion: string): Promise<string | null> {
  // Default: hit /health directly on the daemon port (same host as DSM).
  // When the daemon binds loopback-only (fronted by `tailscale serve`), that
  // port isn't reachable from here, so MCP_HEALTH_URL overrides with the serve
  // endpoint. Bearer not required for /health.
  const url =
    process.env.MCP_HEALTH_URL ??
    `http://${new URL(cfg.baseUrl).hostname}:${HEALTH_PORT_DEFAULT}/health`;
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let reached = false;
  let lastErr: string | undefined;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      reached = true;
      if (res.ok) {
        const body = (await res.json()) as any;
        if (body?.version === expectedVersion) {
          log(`✓ ${url} reports version ${body.version}`);
          return body.version;
        }
        lastErr = `version=${body?.version}, expected=${expectedVersion}`;
      } else {
        lastErr = `HTTP ${res.status}`;
      }
    } catch (err: any) {
      lastErr = err?.message ?? String(err);
    }
    await sleep(POLL_INTERVAL_MS);
  }
  // Never got an HTTP response → the daemon is almost certainly bound to loopback
  // (MCP_BIND_HOST=127.0.0.1, the recommended default) and simply isn't reachable
  // from here. Expected, not a failure — let the caller warn instead of aborting.
  if (!reached) return null;
  // Reached but never the expected version → a real failure (bad image, stuck build).
  throw new Error(
    `/health at ${url} never reported ${expectedVersion} within ${POLL_TIMEOUT_MS / 1000}s ` +
      `(last=${lastErr}) — the new build may not have started.`
  );
}

/** Deploy = log in as the deploy user, then provision. install() reuses
 *  provisionWithAuth with a session it already validated against the operator's
 *  entered creds. */
export async function deploy(cfg: Config, args: DeployArgs): Promise<DeployResult> {
  const auth = await loginForDeploy(cfg);
  log(`logged in as ${auth.user}`);
  try {
    return await provisionWithAuth(cfg, auth, args);
  } finally {
    await logout(cfg, auth);
  }
}

async function provisionWithAuth(
  cfg: Config,
  auth: { sid: string; synotoken: string; user: string },
  args: DeployArgs
): Promise<DeployResult> {
  const tarPath = args.tar;
  const projectName = args.project ?? PROJECT_NAME_DEFAULT;

  const st = await stat(tarPath).catch(() => null);
  if (!st || !st.isFile()) {
    throw new Error(`tar not found at ${tarPath}`);
  }
  log(`tar: ${tarPath} (${(st.size / 1024 / 1024).toFixed(1)} MB)`);

  // Read the version we expect from package.json so the /health check is
  // tied to the build under deploy, not the file name.
  const pkg = JSON.parse(
    await readFile(
      join(fileURLToPath(import.meta.url), "..", "..", "package.json"),
      "utf8"
    )
  );
  const expectedVersion = pkg.version as string;
  log(`target version: ${expectedVersion}`);

  // 1. Upload + import (one call via the chunked-upload URL). auth (SID +
  // SynoToken) is carried explicitly — every mutating Docker.* endpoint needs the
  // CSRF token.
  await uploadImage(cfg, auth, tarPath);

  // 2. Install-or-update: sync the compose, creating the project on first install.
  //    Secrets (the 3 files in ./secrets) stay operator-owned and are never
  //    touched here — the daemon reads them read-only.
  const composeContent = await repoComposeContent();
  const projDir = `/docker/${projectName}`;
  const existing = await findProject(cfg, auth, projectName);
  let projectId: string;
  let status: string;
  if (existing) {
    const composeName = await existingComposeName(cfg, auth, projDir);
    await uploadText(cfg, auth, projDir, composeName, composeContent);
    log(`synced ${composeName} → existing project`);
    projectId = existing.id;
    status = existing.status;
  } else {
    log(`project '${projectName}' not found — first install, creating it`);
    await ensureProjectDir(cfg, auth, projectName);
    projectId = await createProject(cfg, auth, projectName, projDir, composeContent);
    // Re-read the authoritative status rather than assume CREATED — if a DSM build
    // leaves create RUNNING, rebuildProject must still stop it first (skipping the
    // stop on a live container fires the "stopped unexpectedly" alert we avoid).
    status = (await findProject(cfg, auth, projectName))?.status ?? "CREATED";
  }

  // 3. Rebuild (picks up new compose + image). No auto-rollback: the synced compose is
  //    the tool's own tested file, so a build failure is an image/DSM problem a compose
  //    restore wouldn't fix. Let the error bubble up — the caller decides what to do.
  await rebuildProject(cfg, auth, projectId, status);

  const healthVersion = await pollHealth(cfg, expectedVersion);
  if (healthVersion === null) {
    log(
      `deployed, but /health wasn't reachable from here — expected when the daemon binds loopback ` +
        `(MCP_BIND_HOST=127.0.0.1, the default). Verify via the container log or the tailscale-serve ` +
        `URL (https://<nas>.<tailnet>.ts.net/health), or set MCP_HEALTH_URL to poll it directly.`
    );
  }

  return {
    imageImported: true,
    projectId,
    healthVersion: healthVersion ?? `${expectedVersion} (not verified from here)`,
  };
}

// ─── Install / update (the published `synology-mcp install|update`) ───────────

async function pkgJson(): Promise<any> {
  return JSON.parse(
    await readFile(join(fileURLToPath(import.meta.url), "..", "..", "package.json"), "utf8")
  );
}

/** owner/repo parsed from package.json's repository url — for the release download. */
function repoSlug(pkg: any): string {
  const url: string = pkg?.repository?.url ?? pkg?.repository ?? "";
  const m = url.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/);
  if (!m) {
    throw new Error(`can't derive the GitHub repo from package.json repository (${url}) — pass --tar`);
  }
  return m[1];
}

/** True iff `data` hashes to the expected lowercase-hex sha256. A malformed/empty
 *  expected (e.g. a 404 page saved as the .sha256) is treated as NO match. */
export function sha256Matches(expectedHex: string, data: Buffer): boolean {
  if (!/^[0-9a-f]{64}$/.test(expectedHex)) return false;
  return createHash("sha256").update(data).digest("hex") === expectedHex;
}

/** curl a URL to a file with TLS verification ON — no `-k`, so this VERIFIES
 *  github.com's cert regardless of the process-wide NODE_TLS_REJECT_UNAUTHORIZED=0
 *  we set for DSM's self-signed cert. -f: fail (nonzero) on an HTTP error instead
 *  of saving a 404 page. -L: follow the redirect to objects.githubusercontent.com. */
async function curlDownload(url: string, dest: string): Promise<void> {
  try {
    await execFileP("curl", ["-fSL", "--retry", "2", "-o", dest, url], {
      maxBuffer: 1024 * 1024,
    });
  } catch (err: any) {
    throw new Error(
      `download failed: ${url} (curl ${err?.code ?? "error"}). Ensure the release asset exists, ` +
        `or build locally and pass --tar <path>.`
    );
  }
}

/** Download the release image tar matching this CLI's version to a temp file and
 *  verify its published sha256. curl (not Node fetch) so TLS to GitHub is verified
 *  even though the DSM path disables verification process-wide. */
async function downloadReleaseTar(pkg: any, version: string): Promise<string> {
  const asset = `synology-mcp-${version}-amd64.tar`;
  const base = `https://github.com/${repoSlug(pkg)}/releases/download/v${version}`;
  const dir = await mkdtemp(join(tmpdir(), "synmcp-install-"));
  const dest = join(dir, asset);
  const sumPath = `${dest}.sha256`;
  log(`downloading image ${base}/${asset} …`);
  await curlDownload(`${base}/${asset}`, dest);
  await curlDownload(`${base}/${asset}.sha256`, sumPath);
  // Integrity check: refuse a truncated/tampered asset. (The checksum is published
  // alongside the tar, so this is not a signature — TLS-verified GitHub is the trust
  // anchor; the hash catches corruption and the redirect hop.)
  const expected = (await readFile(sumPath, "utf8")).trim().split(/\s+/)[0];
  const data = await readFile(dest);
  if (!sha256Matches(expected, data)) {
    const actual = createHash("sha256").update(data).digest("hex");
    throw new Error(
      `image checksum mismatch for ${asset} (expected ${expected || "?"}, got ${actual}) — ` +
        `refusing to import. Retry, or build locally and pass --tar <path>.`
    );
  }
  const size = (await stat(dest)).size;
  log(`image saved + sha256-verified (${(size / 1024 / 1024).toFixed(1)} MB)`);
  return dest;
}

/** --tar wins; else download the release tar for `version`. temp=true → caller removes it. */
async function resolveTar(
  pkg: any,
  opts: { tar?: string },
  version: string
): Promise<{ tar: string; temp: boolean }> {
  if (opts.tar) return { tar: opts.tar, temp: false };
  return { tar: await downloadReleaseTar(pkg, version), temp: true };
}

/** Push the three credential files into /docker/<project>/secrets over stdin
 *  (never on the Mac's disk). create_parents makes the dir; the daemon reads them
 *  read-only (the admin-gated docker share is the at-rest control). */
async function pushSecrets(
  cfg: Config,
  auth: { sid: string; synotoken: string },
  projectName: string,
  creds: InstallCredentials
): Promise<void> {
  const dir = `/docker/${projectName}/secrets`;
  await uploadText(cfg, auth, dir, "dsm_password", creds.password);
  await uploadText(cfg, auth, dir, "dsm_totp", creds.totpSecret);
  await uploadText(cfg, auth, dir, "mcp_bearer", creds.bearer);
  log(`pushed 3 secret files → ${dir}`);
}

export interface InstallArgs {
  /** Local image tar; else the matching GitHub release is downloaded. */
  tar?: string;
  /** Called with the generated bearer once secrets are pushed — BEFORE the health
   *  poll, so the "store this" line prints even if the poll can't reach a
   *  loopback-bound daemon from the operator's Mac. */
  onBearer?: (bearer: string) => void;
}

/** First install: gather + validate creds, push secrets, provision. Returns the
 *  generated bearer so the CLI can print the client-wiring line. */
export async function install(
  cfg: Config,
  opts: InstallArgs
): Promise<{ bearer: string; healthVersion: string }> {
  const pkg = await pkgJson();
  const version = pkg.version as string;
  const creds = await gatherInstallCredentials();
  log(`validating DSM login as ${cfg.user} …`);
  const auth = await loginWithCreds(cfg, cfg.user, creds.password, creds.totpSecret);
  log(`login OK`);
  // Resolve the image BEFORE pushing secrets: a missing release (the most likely
  // failure) then aborts without leaving plaintext secret files orphaned on the NAS.
  const { tar, temp } = await resolveTar(pkg, opts, version);
  try {
    await ensureProjectDir(cfg, auth, PROJECT_NAME_DEFAULT);
    await pushSecrets(cfg, auth, PROJECT_NAME_DEFAULT, creds);
    // The bearer is valid now, independent of whether the health poll below can
    // reach the daemon — surface it before we risk a poll timeout.
    opts.onBearer?.(creds.bearer);
    const result = await provisionWithAuth(cfg, auth, { tar });
    return { bearer: creds.bearer, healthVersion: result.healthVersion };
  } finally {
    if (temp) await rm(dirname(tar), { recursive: true, force: true }).catch(() => {});
    await logout(cfg, auth);
  }
}

/** Update an existing install to this CLI's version. Re-authenticates from
 *  DSM_DEPLOY_* / DSM_* env or an interactive prompt (op users: `op run`); needs
 *  only password + TOTP, no bearer. */
export async function update(cfg: Config, opts: { tar?: string }): Promise<DeployResult> {
  const pkg = await pkgJson();
  const { tar, temp } = await resolveTar(pkg, opts, pkg.version as string);
  try {
    return await deploy(cfg, { tar });
  } finally {
    if (temp) await rm(dirname(tar), { recursive: true, force: true }).catch(() => {});
  }
}
