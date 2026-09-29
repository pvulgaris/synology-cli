/**
 * Container Manager tools.
 *
 * DSM exposes Compose projects, containers, logs, and images through separate
 * `SYNO.Docker.*` APIs. These endpoints are not part of Synology's public Web
 * API guide, so the request shapes below are limited to operations verified
 * against DSM 7.3 / Container Manager 24.0.2.
 */

import { createHash } from "node:crypto";
import fs from "node:fs/promises";

import type { RuntimeConfig } from "../config.js";
import type { SynoClient } from "../client.js";
import {
  SynologyApiError,
  isSensitiveParamKey,
  isSoftTransportError,
} from "../client.js";
import { withAudit } from "../audit.js";
import { poll } from "./poll.js";

interface ProjectSummaryWire {
  id?: string;
  name?: string;
  status?: string;
  containerIds?: string[] | null;
  containers?: ContainerWire[];
}

interface ContainerWire {
  id?: string;
  name?: string;
  image?: string;
  status?: string;
  Name?: string;
  Config?: {
    Image?: string;
    User?: string;
  };
  State?: {
    Status?: string;
    Running?: boolean;
    ExitCode?: number;
    Health?: { Status?: string; FailingStreak?: number };
  };
  RestartCount?: number;
}

interface ContainerListWire {
  containers?: ContainerWire[];
  total?: number;
}

interface ContainerLogWire {
  total?: number;
  logs?: Array<{ created?: string; stream?: string; text?: string }>;
}

interface ContainerCpuStatsWire {
  cpu_usage?: { total_usage?: number };
  online_cpus?: number;
  system_cpu_usage?: number;
}

interface ContainerStatsWire {
  id?: string;
  name?: string;
  read?: string;
  cpu_stats?: ContainerCpuStatsWire;
  memory_stats?: {
    usage?: number;
    limit?: number;
    stats?: { total_inactive_file?: number; inactive_file?: number };
  };
  networks?: Record<string, { rx_bytes?: number; tx_bytes?: number }>;
  blkio_stats?: {
    io_service_bytes_recursive?: Array<{ op?: string; value?: number }> | null;
  };
}

type ContainerStatsListWire = Record<string, ContainerStatsWire>;

interface ContainerDetailWire {
  details?: {
    Name?: string;
    Config?: {
      Image?: string;
      Entrypoint?: string[] | string | null;
      Cmd?: string[] | null;
      Env?: string[] | null;
      Labels?: Record<string, string> | null;
    };
    HostConfig?: { NetworkMode?: string };
    Mounts?: Array<{
      Type?: string;
      Source?: string;
      Destination?: string;
      Mode?: string;
      RW?: boolean;
    }>;
  };
}

interface ImageListWire {
  images?: Array<{
    id?: string;
    repository?: string;
    tags?: string[];
    size?: number;
    created?: number;
    upgradable?: boolean;
  }>;
  total?: number;
}

export interface ContainerState {
  id?: string;
  name: string;
  image?: string;
  user?: string;
  status?: string;
  running?: boolean;
  health?: string | null;
  health_failing_streak?: number | null;
  exit_code?: number;
  restart_count?: number;
}

export interface ProjectState {
  id: string;
  name: string;
  status?: string;
  container_count: number;
  containers?: ContainerState[];
}

const PROJECT_POLL_MS = 2_000;
const PROJECT_STOP_TIMEOUT_MS = 60_000;
const PROJECT_BUILD_TIMEOUT_MS = 5 * 60_000;
const CONTAINER_POLL_MS = 1_000;
const CONTAINER_CONTROL_TIMEOUT_MS = 60_000;

function stripLeadingSlash(name: string): string {
  return name.startsWith("/") ? name.slice(1) : name;
}

function normalizeContainer(c: ContainerWire): ContainerState {
  const state = c.State;
  return {
    id: c.id,
    name: stripLeadingSlash(c.Name ?? c.name ?? ""),
    image: c.Config?.Image ?? c.image,
    user: c.Config?.User,
    status: state?.Status ?? c.status,
    running: state?.Running ?? (c.status ? c.status === "running" : undefined),
    health: state?.Health?.Status ?? null,
    health_failing_streak: state?.Health?.FailingStreak ?? null,
    exit_code: state?.ExitCode,
    restart_count: c.RestartCount,
  };
}

function normalizeProject(
  project: ProjectSummaryWire,
  fallbackId: string,
  containers?: ContainerWire[]
): ProjectState {
  const normalizedContainers = containers?.map(normalizeContainer);
  return {
    id: project.id ?? fallbackId,
    name: project.name ?? fallbackId,
    status: project.status,
    container_count: normalizedContainers?.length ?? project.containerIds?.length ?? 0,
    ...(normalizedContainers ? { containers: normalizedContainers } : {}),
  };
}

async function listProjectsRaw(
  dsm: SynoClient
): Promise<Record<string, ProjectSummaryWire>> {
  return dsm.call<Record<string, ProjectSummaryWire>>({
    api: "SYNO.Docker.Project",
    method: "list",
    version: 1,
  });
}

/** Resolve a name or id to the live project id. Only the id is returned: the
 *  list entry's fields are all re-read by `Project.get`, so keeping it would be
 *  a pre-stop snapshot that the detail read overwrites anyway. */
async function resolveProjectId(dsm: SynoClient, nameOrId: string): Promise<string> {
  const projects = await listProjectsRaw(dsm);
  if (projects[nameOrId]) return nameOrId;
  const matches = Object.entries(projects).filter(
    ([, project]) => project.name === nameOrId || project.id === nameOrId
  );
  if (matches.length === 0) {
    throw new Error(`Container Manager project "${nameOrId}" not found.`);
  }
  if (matches.length > 1) {
    throw new Error(`Container Manager project name "${nameOrId}" is ambiguous; use its id.`);
  }
  return matches[0][0];
}

export async function nasContainerProjectInfo(
  dsm: SynoClient,
  nameOrId: string
): Promise<ProjectState> {
  return projectInfoById(dsm, await resolveProjectId(dsm, nameOrId));
}

async function projectInfoById(dsm: SynoClient, id: string): Promise<ProjectState> {
  const detail = await dsm.call<ProjectSummaryWire>({
    api: "SYNO.Docker.Project",
    method: "get",
    version: 1,
    params: { id: JSON.stringify(id) },
    sensitiveResponse: true,
  });
  return normalizeProject(detail, id, detail.containers);
}

export async function nasContainerProjectsList(dsm: SynoClient) {
  const raw = await listProjectsRaw(dsm);
  return {
    projects: Object.entries(raw).map(([id, project]) => normalizeProject(project, id)),
  };
}

export async function nasContainersList(dsm: SynoClient) {
  // offset, limit and type are all required; omitting them returns code 114.
  const data = await dsm.call<ContainerListWire>({
    api: "SYNO.Docker.Container",
    method: "list",
    version: 1,
    params: { offset: 0, limit: -1, type: JSON.stringify("all") },
  });
  return {
    containers: (data.containers ?? []).map(normalizeContainer),
    total: data.total ?? data.containers?.length ?? 0,
  };
}

async function findContainer(
  dsm: SynoClient,
  name: string
): Promise<ContainerState | null> {
  const data = await nasContainersList(dsm);
  return data.containers.find((container) => container.name === stripLeadingSlash(name)) ?? null;
}

function stringList(value: string[] | string | null | undefined): string[] {
  if (Array.isArray(value)) return value;
  return value ? [value] : [];
}

function redactCommandArgs(values: string[]): string[] {
  let redactNext = false;
  return values.map((value) => {
    if (redactNext) {
      redactNext = false;
      return "***";
    }
    const separator = value.indexOf("=");
    if (separator >= 0) {
      const key = value.slice(0, separator).replace(/^-+/, "");
      if (isSensitiveParamKey(key)) return `${value.slice(0, separator + 1)}***`;
    }
    if (value.startsWith("-") && isSensitiveParamKey(value.replace(/^-+/, ""))) {
      redactNext = true;
    }
    return value.replace(/:\/\/([^:@/\s]+):([^@/\s]+)@/g, "://$1:***@");
  });
}

export async function nasContainerInfo(dsm: SynoClient, nameInput: string) {
  const name = stripLeadingSlash(nameInput);
  const data = await dsm.call<ContainerDetailWire>({
    api: "SYNO.Docker.Container",
    method: "get",
    version: 1,
    params: { name: JSON.stringify(name) },
    sensitiveResponse: true,
  });
  const details = data.details;
  if (!details) throw new Error(`Container Manager returned no details for "${name}".`);
  const config = details.Config;
  const labels = config?.Labels ?? {};
  const environmentKeys = (config?.Env ?? []).map((entry) => entry.split("=", 1)[0]);
  return {
    name: stripLeadingSlash(details.Name ?? name),
    image: config?.Image,
    command: {
      entrypoint: redactCommandArgs(stringList(config?.Entrypoint)),
      args: redactCommandArgs(config?.Cmd ?? []),
    },
    network_mode: details.HostConfig?.NetworkMode,
    mounts: (details.Mounts ?? []).map((mount) => ({
      type: mount.Type,
      source: mount.Source,
      destination: mount.Destination,
      mode: mount.Mode,
      read_write: mount.RW,
    })),
    environment_keys: [...new Set(environmentKeys)].sort(),
    compose: {
      project: labels["com.docker.compose.project"],
      service: labels["com.docker.compose.service"],
    },
  };
}

/**
 * `stats` is a GET read keyed by container ID. Stopped containers stay in the
 * response with empty counters and a zero-date `read`, and `precpu_stats` is
 * always empty, so CPU percentage needs two calls.
 */
async function readContainerStats(dsm: SynoClient): Promise<ContainerStatsListWire> {
  return dsm.call<ContainerStatsListWire>({
    api: "SYNO.Docker.Container",
    method: "stats",
    version: 1,
  });
}

function findContainerStats(
  snapshots: ContainerStatsListWire,
  name: string
): ContainerStatsWire | undefined {
  return Object.values(snapshots).find(
    (snapshot) => stripLeadingSlash(snapshot.name ?? "") === name
  );
}

function cpuPercent(
  current: ContainerCpuStatsWire | undefined,
  previous: ContainerCpuStatsWire | undefined
): number | null {
  const used = current?.cpu_usage?.total_usage;
  const previousUsed = previous?.cpu_usage?.total_usage;
  const system = current?.system_cpu_usage;
  const previousSystem = previous?.system_cpu_usage;
  const cpus = current?.online_cpus;
  if (
    used === undefined ||
    previousUsed === undefined ||
    system === undefined ||
    previousSystem === undefined ||
    !cpus
  ) return null;
  const usedDelta = used - previousUsed;
  const systemDelta = system - previousSystem;
  if (usedDelta < 0 || systemDelta <= 0) return null;
  return Math.round((usedDelta / systemDelta) * cpus * 10_000) / 100;
}

function memoryUsed(stats: ContainerStatsWire): number {
  const usage = stats.memory_stats?.usage ?? 0;
  const inactive =
    stats.memory_stats?.stats?.total_inactive_file ??
    stats.memory_stats?.stats?.inactive_file ??
    0;
  return inactive < usage ? usage - inactive : usage;
}

function networkBytes(
  stats: ContainerStatsWire,
  field: "rx_bytes" | "tx_bytes"
): number {
  return Object.values(stats.networks ?? {}).reduce(
    (total, network) => total + (network[field] ?? 0),
    0
  );
}

function blockBytes(stats: ContainerStatsWire, operation: "read" | "write"): number {
  return (stats.blkio_stats?.io_service_bytes_recursive ?? []).reduce(
    (total, entry) =>
      entry.op?.toLowerCase() === operation ? total + (entry.value ?? 0) : total,
    0
  );
}

export async function nasContainerStats(dsm: SynoClient, nameInput: string) {
  const name = stripLeadingSlash(nameInput);
  const container = await findContainer(dsm, name);
  if (!container) throw new Error(`Container "${name}" not found.`);

  const first = findContainerStats(await readContainerStats(dsm), name);
  if (!first) throw new Error(`Container Manager returned no stats for "${name}".`);
  const current = container.running
    ? findContainerStats(await readContainerStats(dsm), name) ?? first
    : first;
  const used = memoryUsed(current);
  const limit = current.memory_stats?.limit ?? 0;
  return {
    id: current.id ?? container.id,
    name,
    status: container.status,
    running: container.running,
    sampled_at: current.read,
    cpu_percent: container.running
      ? cpuPercent(current.cpu_stats, first.cpu_stats)
      : null,
    memory_used_bytes: used,
    memory_limit_bytes: limit,
    memory_percent:
      limit > 0 ? Math.round((used / limit) * 10_000) / 100 : null,
    network_rx_bytes: networkBytes(current, "rx_bytes"),
    network_tx_bytes: networkBytes(current, "tx_bytes"),
    block_read_bytes: blockBytes(current, "read"),
    block_write_bytes: blockBytes(current, "write"),
  };
}

export async function nasContainerLogs(
  dsm: SynoClient,
  args: { name: string; limit?: number }
) {
  const limit = args.limit ?? 200;
  if (!Number.isInteger(limit) || limit < 1 || limit > 5_000) {
    throw new Error("Container log limit must be an integer from 1 through 5000.");
  }
  // DSM exposes log reads as a POST-only endpoint. This is still a read: it is
  // deliberately neither confirmation-gated nor written to the mutation audit.
  const data = await dsm.call<ContainerLogWire>({
    api: "SYNO.Docker.Container.Log",
    method: "get",
    version: 1,
    post: true,
    params: {
      name: JSON.stringify(stripLeadingSlash(args.name)),
      sort_dir: JSON.stringify("DESC"),
      offset: 0,
      limit,
    },
  });
  return {
    name: stripLeadingSlash(args.name),
    total: data.total ?? data.logs?.length ?? 0,
    logs: [...(data.logs ?? [])].reverse().map((entry) => ({
      created: entry.created,
      stream: entry.stream,
      text: entry.text,
    })),
  };
}

async function waitForContainer(
  dsm: SynoClient,
  name: string,
  predicate: (container: ContainerState | null) => boolean,
  timeoutMs = CONTAINER_CONTROL_TIMEOUT_MS
): Promise<ContainerState | null> {
  return poll({
    read: () => findContainer(dsm, name),
    done: predicate,
    intervalMs: CONTAINER_POLL_MS,
    timeoutMs,
  });
}

async function containerMutation(
  dsm: SynoClient,
  method: "start" | "stop" | "delete",
  params: Record<string, string | boolean>
): Promise<string | null> {
  try {
    await dsm.call({
      api: "SYNO.Docker.Container",
      method,
      version: 1,
      post: true,
      params,
    });
    return null;
  } catch (err) {
    if (!isSoftTransportError(err)) throw err;
    return String((err as Error).message ?? err);
  }
}

export async function nasContainerControl(
  cfg: RuntimeConfig,
  dsm: SynoClient,
  args: { name: string; action: "start" | "stop" }
) {
  const name = stripLeadingSlash(args.name);
  const before = await findContainer(dsm, name);
  if (!before) throw new Error(`Container "${name}" not found.`);
  const desiredRunning = args.action !== "stop";
  const failure = `Container "${name}" did not become ${desiredRunning ? "running" : "stopped"}.`;
  const { after, ok } = await withAudit(
    cfg,
    { tool: "containers.control", args: { name, action: args.action }, before },
    async (audit) => {
      const writeError = await containerMutation(dsm, args.action, {
        name: JSON.stringify(name),
      });
      if (writeError) audit.write_error = writeError;
      const state = await waitForContainer(
        dsm,
        name,
        (container) => container?.running === desiredRunning
      );
      const verified = state?.running === desiredRunning;
      return {
        after: state,
        ok: verified,
        error: verified ? undefined : failure,
      };
    }
  );
  if (!ok) throw new Error(failure);
  return { before, after };
}

export async function nasContainerRemove(
  cfg: RuntimeConfig,
  dsm: SynoClient,
  args: { name: string }
) {
  const name = stripLeadingSlash(args.name);
  const before = await findContainer(dsm, name);
  if (!before) throw new Error(`Container "${name}" not found.`);
  if (before.running) {
    throw new Error(`Container "${name}" is running; stop it first.`);
  }
  const failure = `Container "${name}" still exists after delete.`;
  const { after, ok } = await withAudit(
    cfg,
    { tool: "containers.remove", args: { name }, before },
    async (audit) => {
      const writeError = await containerMutation(dsm, "delete", {
        name: JSON.stringify(name),
        force: false,
        preserve_profile: false,
      });
      if (writeError) audit.write_error = writeError;
      const state = await waitForContainer(dsm, name, (container) => container === null);
      const removed = state === null;
      return {
        after: state,
        ok: removed,
        error: removed ? undefined : failure,
      };
    }
  );
  if (!ok) throw new Error(failure);
  return { before, after };
}

export async function nasContainerImagesList(dsm: SynoClient) {
  // offset and limit are required; omitting them returns code 114.
  const data = await dsm.call<ImageListWire>({
    api: "SYNO.Docker.Image",
    method: "list",
    version: 1,
    params: { offset: 0, limit: -1 },
  });
  return {
    images: (data.images ?? []).map((image) => ({
      id: image.id,
      repository: image.repository,
      tags: image.tags ?? [],
      size: image.size,
      created: image.created,
      upgradable: image.upgradable,
    })),
    total: data.total ?? data.images?.length ?? 0,
  };
}

function projectReady(project: ProjectState): boolean {
  const containers = project.containers ?? [];
  if (containers.length === 0 || !containers.some((container) => container.running)) return false;
  return containers.every((container) => {
    if (container.running) {
      return container.health !== "starting" && container.health !== "unhealthy";
    }
    return container.status === "exited" && container.exit_code === 0;
  });
}

async function waitForProject(
  dsm: SynoClient,
  projectId: string,
  predicate: (state: ProjectState) => boolean,
  timeoutMs: number
): Promise<ProjectState> {
  return poll({
    read: () => projectInfoById(dsm, projectId),
    done: predicate,
    intervalMs: PROJECT_POLL_MS,
    timeoutMs,
  });
}

// Build and stop can return 1202 after doing the work: a build whose one-shot
// service exited 0 sets project status WARNING while the long-running
// containers are healthy. So 1202 means "verify", never success or failure.
function ambiguousProjectError(err: unknown): boolean {
  if (err instanceof SynologyApiError) return err.code === 1202;
  return isSoftTransportError(err);
}

async function projectMutation(
  dsm: SynoClient,
  id: string,
  method: "stop" | "build"
): Promise<string | null> {
  try {
    await dsm.call({
      api: "SYNO.Docker.Project",
      method,
      version: 1,
      post: true,
      params: { id: JSON.stringify(id) },
    });
    return null;
  } catch (err) {
    if (!ambiguousProjectError(err)) throw err;
    return String((err as Error).message ?? err);
  }
}

export async function nasContainerProjectDeploy(
  cfg: RuntimeConfig,
  dsm: SynoClient,
  args: { project: string; file: string }
) {
  const content = await fs.readFile(args.file, "utf8");
  if (content.trim().length === 0) throw new Error(`Compose file "${args.file}" is empty.`);
  const composeSha256 = createHash("sha256").update(content).digest("hex");
  const projectId = await resolveProjectId(dsm, args.project);
  const before = await projectInfoById(dsm, projectId);
  const failure = `Project "${before.name}" did not reach a ready state after build.`;

  const { after, ok } = await withAudit(
    cfg,
    {
      tool: "containers.projects.deploy",
      args: { project: before.name, file: args.file, compose_sha256: composeSha256 },
      before,
    },
    async (audit) => {
      if (before.containers?.some((container) => container.running)) {
        const stopError = await projectMutation(dsm, projectId, "stop");
        if (stopError) audit.stop_error = stopError;
        const stopped = await waitForProject(
          dsm,
          projectId,
          (state) => !(state.containers ?? []).some((container) => container.running),
          PROJECT_STOP_TIMEOUT_MS
        );
        if ((stopped.containers ?? []).some((container) => container.running)) {
          audit.last_state = stopped;
          throw new Error(`Project "${before.name}" did not stop before its definition was updated.`);
        }
      }

      // update only replaces the stored Compose content; start would reuse the
      // old containers, so build is what converges them. Build does not pass
      // --remove-orphans, so a removed service can survive it.
      await dsm.call({
        api: "SYNO.Docker.Project",
        method: "update",
        version: 1,
        post: true,
        params: { id: JSON.stringify(projectId), content: JSON.stringify(content) },
        sensitiveResponse: true,
      });

      const buildError = await projectMutation(dsm, projectId, "build");
      if (buildError) audit.build_error = buildError;
      const state = await waitForProject(
        dsm,
        projectId,
        projectReady,
        PROJECT_BUILD_TIMEOUT_MS
      );
      const verified = projectReady(state);
      if (!verified) audit.last_state = state;
      return {
        after: state,
        ok: verified,
        error: verified ? undefined : failure,
      };
    }
  );

  if (!ok) throw new Error(failure);

  return {
    before,
    after,
    compose_sha256: composeSha256,
  };
}
