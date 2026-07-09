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
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, mkdtemp, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { authenticator } from "otplib";
import { type Config, envValue } from "../config.js";
import { loadDsmOnlyCredentials, credsFromPrefix } from "../auth.js";

const execFileP = promisify(execFile);

const PROJECT_NAME_DEFAULT = "synology-mcp";
const HEALTH_PORT_DEFAULT = 8765;
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 120_000;

interface DeployArgs {
  tar: string;
  project?: string;
  healthPort?: number;
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

/** Mint a fresh SID via TOTP. We don't reuse the cached SID for deploys
 *  because deploys can run as a different user (DSM_DEPLOY_USER) than the
 *  runtime claude-mcp. A fresh login keeps user separation explicit. */
async function loginForDeploy(
  cfg: Config
): Promise<{ sid: string; synotoken: string; user: string }> {
  // Deploy needs only password + TOTP (no bearer). An explicit DSM_DEPLOY_* pair (env
  // or *_FILE) wins; else the runtime DSM_* login secrets (bearer-free). credsFromPrefix
  // fails loud on a half-set pair or a misconfig — it never silently mixes a
  // DSM_DEPLOY_USER with the runtime DSM_* password.
  const user = envValue("DSM_DEPLOY_USER") ?? cfg.user;
  const { password, totpSecret } =
    credsFromPrefix("DSM_DEPLOY") ?? (await loadDsmOnlyCredentials("DSM"));
  const totp = authenticator.generate(totpSecret);
  // POST with credentials in the form BODY, never the URL query string — DSM access
  // logs and any proxy record request URLs, not bodies.
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
      `Deploy login failed (code ${code}). Set DSM_DEPLOY_USER/PASSWORD/TOTP_SECRET to use a different admin account.`
    );
  }
  return {
    sid: body.data.sid,
    synotoken: body.data.synotoken ?? "",
    user,
  };
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
  const { stdout } = await execFileP("curl", args, { maxBuffer: 4 * 1024 * 1024 });
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
function entryCgiUrl(
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
  const args: string[] = [...curlBase(cfg), "-X", "POST", entryCgiUrl(cfg, auth)];
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
  const { stdout } = await execFileP("curl", args, { maxBuffer: 16 * 1024 * 1024 });
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
    join(new URL(import.meta.url).pathname, "..", "..", "..", "synology.compose.yml"),
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
  // Unique temp dir per call (no fixed-path collision between concurrent deploys),
  // and the write is inside the try so a partial write is still cleaned up. Mode
  // 0600 in case this helper is later reused for secret content.
  const dir = await mkdtemp(join(tmpdir(), "synmcp-deploy-"));
  const tmp = join(dir, filename);
  try {
    await writeFile(tmp, content, { mode: 0o600 });
    const url = entryCgiUrl(cfg, auth, {
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
      "-F", `file=@${tmp};filename=${filename}`,
    ];
    const { stdout } = await execFileP("curl", args, { maxBuffer: 1024 * 1024 });
    let body: any;
    try {
      body = JSON.parse(stdout);
    } catch {
      throw new Error(`FileStation.Upload returned non-JSON: ${stdout.slice(0, 200)}`);
    }
    if (!body?.success) {
      throw new Error(`FileStation.Upload ${filename} failed (code ${body?.error?.code})`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
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

/** Poll the daemon's /health until it reports the version we just shipped. */
async function pollHealth(
  cfg: Config,
  expectedVersion: string,
  port: number
): Promise<string> {
  // Default: hit /health directly on the daemon port (same host as DSM).
  // When the daemon binds loopback-only (fronted by `tailscale serve`), that
  // port isn't reachable from here, so MCP_HEALTH_URL overrides with the serve
  // endpoint. Bearer not required for /health.
  const url =
    process.env.MCP_HEALTH_URL ??
    `http://${new URL(cfg.baseUrl).hostname}:${port}/health`;
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let lastErr: string | undefined;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
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
  throw new Error(
    `/health never reported ${expectedVersion} within ${POLL_TIMEOUT_MS / 1000}s (${url}); ` +
      `last=${lastErr}. If the daemon binds loopback (MCP_BIND_HOST=127.0.0.1, the default) ` +
      `it isn't reachable at the NAS's LAN/tailnet IP:${port} unless tailscaled forwards it — ` +
      `set MCP_HEALTH_URL to the tailscale-serve endpoint (e.g. https://<nas>.<tailnet>.ts.net/health).`
  );
}

export async function deploy(cfg: Config, args: DeployArgs): Promise<DeployResult> {
  const tarPath = args.tar;
  const projectName = args.project ?? PROJECT_NAME_DEFAULT;
  const healthPort = args.healthPort ?? HEALTH_PORT_DEFAULT;

  const st = await stat(tarPath).catch(() => null);
  if (!st || !st.isFile()) {
    throw new Error(`tar not found at ${tarPath}`);
  }
  log(`tar: ${tarPath} (${(st.size / 1024 / 1024).toFixed(1)} MB)`);

  // Read the version we expect from package.json so the /health check is
  // tied to the build under deploy, not the file name.
  const pkg = JSON.parse(
    await readFile(
      join(new URL(import.meta.url).pathname, "..", "..", "..", "package.json"),
      "utf8"
    )
  );
  const expectedVersion = pkg.version as string;
  log(`target version: ${expectedVersion}`);

  // Login as the deploy user (defaults to claude-mcp; overridable via env).
  // We carry SID + SynoToken explicitly through the rest of the flow — every
  // mutating Docker.* endpoint requires the CSRF token, and threading it via
  // SynoClient would mean a bigger change for a one-shot path.
  const auth = await loginForDeploy(cfg);
  log(`logged in as ${auth.user}`);

  // 1. Upload + import (one call via the chunked-upload URL)
  await uploadImage(cfg, auth, tarPath);

  // 2. Install-or-update: sync the compose, creating the project on first install.
  //    Secrets (the 3 files in ./secrets) stay operator-owned and are never touched
  //    here — the daemon reads them read-only.
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
  const healthVersion = await pollHealth(cfg, expectedVersion, healthPort);

  return {
    imageImported: true,
    projectId,
    healthVersion,
  };
}
