import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  nasContainerControl,
  nasContainerImagesList,
  nasContainerLogs,
  nasContainerProjectDeploy,
  nasContainerProjectInfo,
  nasContainerProjectsList,
  nasContainerRemove,
  nasContainersList,
} from "./containers.js";
import { DsmError } from "../dsm.js";

function config(auditLogDir: string): any {
  return { auditLogDir };
}

function auditRecords(dir: string): any[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl"))
    .flatMap((name) => readFileSync(join(dir, name), "utf8").trim().split("\n"))
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function reachPendingTimer(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function unchangedContainer(running: boolean, mutation: "stop" | "delete") {
  let listCalls = 0;
  const polling = deferred();
  return {
    polling: polling.promise,
    dsm: {
      call: async (opts: any) => {
        if (opts.method === "list") {
          listCalls += 1;
          if (listCalls === 2) polling.resolve();
          return {
            containers: [{
              id: "abc",
              name: "app",
              image: "example/app",
              status: running ? "running" : "stopped",
            }],
            total: 1,
          };
        }
        if (opts.method === mutation) return {};
        throw new Error(`unexpected method ${opts.method}`);
      },
    } as any,
  };
}

test("container reads supply DSM's required all-results parameters and normalize responses", async () => {
  const calls: any[] = [];
  const dsm = {
    call: async (opts: any) => {
      calls.push(opts);
      if (opts.api === "SYNO.Docker.Container.Log") {
        return {
          total: 2,
          logs: [
            { created: "later", stream: "stderr", text: "second" },
            { created: "earlier", stream: "stdout", text: "first" },
          ],
        };
      }
      if (opts.api === "SYNO.Docker.Image") {
        return {
          total: 1,
          images: [{ id: "sha256:a", repository: "example/app", tags: ["stable"], size: 42 }],
        };
      }
      return {
        total: 1,
        containers: [{ id: "abc", name: "app", image: "example/app:stable", status: "running" }],
      };
    },
  } as any;

  const containers = await nasContainersList(dsm);
  const logs = await nasContainerLogs(dsm, { name: "/app", limit: 10 });
  const images = await nasContainerImagesList(dsm);

  assert.deepEqual(containers.containers[0], {
    id: "abc",
    name: "app",
    image: "example/app:stable",
    user: undefined,
    status: "running",
    running: true,
    health: null,
    health_failing_streak: null,
    exit_code: undefined,
    restart_count: undefined,
  });
  assert.deepEqual(calls[0].params, { offset: 0, limit: -1, type: '"all"' });
  assert.equal(calls[1].post, true, "DSM's read-only log endpoint is POST-only");
  assert.deepEqual(logs.logs.map((entry) => entry.text), ["first", "second"]);
  assert.equal(images.images[0].repository, "example/app");
  assert.deepEqual(calls[2].params, { offset: 0, limit: -1 });
});

test("project reads resolve a name and omit Compose content", async () => {
  const dsm = {
    call: async (opts: any) => {
      if (opts.method === "list") {
        return {
          id1: { id: "id1", name: "demo", status: "RUNNING", containerIds: ["one"] },
        };
      }
      return {
        id: "id1",
        name: "demo",
        status: "RUNNING",
        content: "services:\n  app:\n    environment:\n      PASSWORD: do-not-return",
        containers: [
          {
            Name: "/app",
            Config: { Image: "example/app:stable", User: "1000:1000" },
            State: { Status: "running", Running: true, ExitCode: 0, Health: { Status: "healthy" } },
          },
        ],
      };
    },
  } as any;

  const list = await nasContainerProjectsList(dsm);
  const info = await nasContainerProjectInfo(dsm, "demo");

  assert.equal(list.projects[0].container_count, 1);
  assert.equal(info.id, "id1");
  assert.equal(info.containers?.[0].name, "app");
  assert.equal((info as any).content, undefined);
});

test("project deploy stops, updates, builds, verifies, and never audits Compose content", async () => {
  const dir = mkdtempSync(join(tmpdir(), "syno-container-deploy-"));
  const file = join(dir, "compose.yaml");
  const compose = "services:\n  app:\n    image: example/app:stable\n    environment:\n      PASSWORD: do-not-log\n";
  writeFileSync(file, compose);

  let phase: "old" | "stopped" | "new" = "old";
  const calls: any[] = [];
  const dsm = {
    call: async (opts: any) => {
      calls.push(opts);
      if (opts.api !== "SYNO.Docker.Project") throw new Error("unexpected API");
      if (opts.method === "list") {
        return { id1: { id: "id1", name: "demo", status: phase === "stopped" ? "STOPPED" : "RUNNING" } };
      }
      if (opts.method === "get") {
        const running = phase !== "stopped";
        return {
          id: "id1",
          name: "demo",
          status: running ? "RUNNING" : "STOPPED",
          content: "secret old content",
          containers: [
            {
              Name: "/app",
              Config: { Image: phase === "new" ? "example/app:stable" : "example/app:old", User: "" },
              State: {
                Status: running ? "running" : "exited",
                Running: running,
                ExitCode: 0,
                Health: running ? { Status: "healthy", FailingStreak: 0 } : undefined,
              },
            },
          ],
        };
      }
      if (opts.method === "stop") {
        phase = "stopped";
        throw new DsmError(opts.api, opts.method, 1202, undefined, "ambiguous stop");
      }
      if (opts.method === "update") {
        assert.equal(opts.params.content, JSON.stringify(compose));
        return {};
      }
      if (opts.method === "build") {
        phase = "new";
        throw new DsmError(opts.api, opts.method, 1202, undefined, "ambiguous build");
      }
      throw new Error(`unexpected method ${opts.method}`);
    },
  } as any;

  const result = await nasContainerProjectDeploy(config(dir), dsm, {
    project: "demo",
    file,
  });

  assert.equal("verified" in result, false);
  assert.equal(result.after.containers?.[0].image, "example/app:stable");
  assert.equal(result.compose_sha256.length, 64);
  const records = auditRecords(dir);
  assert.equal(records.length, 1);
  assert.equal(records[0].tool, "containers.projects.deploy");
  assert.equal(JSON.stringify(records).includes("do-not-log"), false);
  assert.deepEqual(
    calls.filter((call) => ["stop", "update", "build"].includes(call.method)).map((call) => call.method),
    ["stop", "update", "build"]
  );
});

test("container control and remove verify ambiguous writes and write audit records", async () => {
  const dir = mkdtempSync(join(tmpdir(), "syno-container-control-"));
  let exists = true;
  let running = true;
  const dsm = {
    call: async (opts: any) => {
      if (opts.method === "list") {
        return {
          containers: exists
            ? [{ id: "abc", name: "app", image: "example/app", status: running ? "running" : "stopped" }]
            : [],
          total: exists ? 1 : 0,
        };
      }
      if (opts.method === "stop") {
        running = false;
        throw new Error("socket hang up");
      }
      if (opts.method === "delete") {
        assert.equal(opts.params.force, false);
        assert.equal(opts.params.preserve_profile, false);
        exists = false;
        throw new Error("terminated");
      }
      throw new Error(`unexpected method ${opts.method}`);
    },
  } as any;

  const stopped = await nasContainerControl(config(dir), dsm, {
    name: "app",
    action: "stop",
  });
  const removed = await nasContainerRemove(config(dir), dsm, { name: "app" });

  assert.equal("verified" in stopped, false);
  assert.equal("removed" in removed, false);
  const records = auditRecords(dir);
  assert.deepEqual(records.map((record) => record.tool), [
    "containers.control",
    "containers.remove",
  ]);
  assert.deepEqual(records.map((record) => record.args.write_error), [
    "socket hang up",
    "terminated",
  ]);
});

test("container writes throw after recording failed verification", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 0 });
  const dir = mkdtempSync(join(tmpdir(), "syno-container-failed-verification-"));

  const runningContainer = unchangedContainer(true, "stop");
  const controlFailure = assert.rejects(
    nasContainerControl(config(dir), runningContainer.dsm, { name: "app", action: "stop" }),
    /did not become stopped/
  );

  const stoppedContainer = unchangedContainer(false, "delete");
  const removeFailure = assert.rejects(
    nasContainerRemove(config(dir), stoppedContainer.dsm, { name: "app" }),
    /still exists after delete/
  );

  const file = join(dir, "compose.yaml");
  writeFileSync(file, "services:\n  app:\n    image: example/app:stable\n");
  let projectGetCalls = 0;
  const projectPolling = deferred();
  const unreadyProject = {
    call: async (opts: any) => {
      if (opts.method === "list") {
        return { id1: { id: "id1", name: "demo", status: "STOPPED" } };
      }
      if (opts.method === "get") {
        projectGetCalls += 1;
        if (projectGetCalls === 2) projectPolling.resolve();
        return {
          id: "id1",
          name: "demo",
          status: "STOPPED",
          containers: [{ Name: "/app", State: { Status: "exited", Running: false, ExitCode: 1 } }],
        };
      }
      if (opts.method === "update" || opts.method === "build") return {};
      throw new Error(`unexpected method ${opts.method}`);
    },
  } as any;
  const deployFailure = assert.rejects(
    nasContainerProjectDeploy(config(dir), unreadyProject, { project: "demo", file }),
    /did not reach a ready state/
  );

  await Promise.all([runningContainer.polling, stoppedContainer.polling, projectPolling.promise]);
  await reachPendingTimer();
  t.mock.timers.setTime(300_001);
  await Promise.all([controlFailure, removeFailure, deployFailure]);

  const records = auditRecords(dir);
  assert.deepEqual(records.map((record) => record.ok), [false, false, false]);
  assert.deepEqual(records.map((record) => record.error).sort(), [
    'Container "app" did not become stopped.',
    'Container "app" still exists after delete.',
    'Project "demo" did not reach a ready state after build.',
  ].sort());
  const byTool = Object.fromEntries(records.map((record) => [record.tool, record]));
  assert.equal(byTool["containers.control"].after.running, true);
  assert.equal(byTool["containers.remove"].after.running, false);
  assert.equal(byTool["containers.projects.deploy"].after.containers[0].exit_code, 1);
});

test("container writes do not treat DSM errors as ambiguous", async () => {
  const dir = mkdtempSync(join(tmpdir(), "syno-container-dsm-error-"));
  let listCalls = 0;
  const dsm = {
    call: async (opts: any) => {
      if (opts.method === "list") {
        listCalls += 1;
        return {
          containers: [{ id: "abc", name: "app", image: "example/app", status: "running" }],
          total: 1,
        };
      }
      throw new DsmError(opts.api, opts.method, 1202, undefined, "DSM refused the write");
    },
  } as any;

  await assert.rejects(
    nasContainerControl(config(dir), dsm, { name: "app", action: "stop" }),
    /DSM refused the write/
  );
  assert.equal(listCalls, 1, "a DSM error must not enter the ambiguous-write poll");
  assert.equal(auditRecords(dir)[0].ok, false);
});
