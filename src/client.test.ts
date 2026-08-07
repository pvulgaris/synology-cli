import { test } from "node:test";
import assert from "node:assert/strict";

import { SynologyApiError, SynoClient, isSoftTransportError } from "./client.js";

function sessionClient(verbose = false): SynoClient {
  const client = new SynoClient(
    {
      platform: "dsm",
      baseUrl: "https://example.test",
      user: "agent",
      envPrefix: "DSM",
      session: "test",
      authVersion: 6,
      authPath: "entry.cgi",
      sidCacheFile: "",
      readOnly: false,
    },
    { verbose }
  );
  Object.assign(client as any, { sid: "test-sid", sidObtainedAt: Date.now() });
  return client;
}

test("transport errors are soft only when DSM did not respond", () => {
  assert.equal(isSoftTransportError(new Error("socket hang up")), true);
  assert.equal(
    isSoftTransportError(new SynologyApiError("SYNO.Foo", "set", 1202, undefined, "terminated")),
    false
  );
});

test("successful DSM calls are quiet unless verbose", async () => {
  const quietClient = sessionClient();
  const verboseClient = sessionClient(true);
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  const trace: unknown[][] = [];
  globalThis.fetch = (async () => ({
    json: async () => ({ success: true, data: { ok: true } }),
  })) as typeof fetch;
  console.error = (...args: unknown[]) => trace.push(args);

  try {
    await quietClient.call({ api: "SYNO.Foo", method: "get" });
    assert.deepEqual(trace, []);
    await verboseClient.call({ api: "SYNO.Foo", method: "get" });
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalError;
  }

  const renderedTrace = JSON.stringify(trace);
  assert.match(renderedTrace, /→ GET SYNO\.Foo\.get/);
  assert.match(renderedTrace, /✓ SYNO\.Foo\.get/);
});

test("SRM read-only policy refuses a mutation before fetch", async () => {
  const client = new SynoClient({
    platform: "srm",
    baseUrl: "https://router.test",
    user: "agent",
    envPrefix: "SRM",
    session: "test-srm",
    authVersion: 3,
    authPath: "auth.cgi",
    sidCacheFile: "",
    readOnly: true,
  });
  await assert.rejects(
    client.call({ api: "SYNO.Core.Foo", method: "set", post: true }),
    /Read-only SynoClient refused/
  );
});

test("DSM traces omit Compose content from requests and debug responses", async () => {
  const client = sessionClient(true);
  const secret = "services:\n  app:\n    environment:\n      PASSWORD: do-not-log";
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  const originalDebug = process.env.DEBUG_DSM_RESPONSES;
  const trace: unknown[][] = [];
  let sentBody = "";
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    sentBody = String(init?.body ?? "");
    return { json: async () => ({ success: true, data: { content: secret } }) } as Response;
  }) as typeof fetch;
  console.error = (...args: unknown[]) => trace.push(args);
  process.env.DEBUG_DSM_RESPONSES = "1";

  try {
    await client.call({
      api: "SYNO.Docker.Project",
      method: "update",
      post: true,
      params: { id: '"project-id"', content: JSON.stringify(secret) },
      sensitiveResponse: true,
    });
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalError;
    if (originalDebug === undefined) delete process.env.DEBUG_DSM_RESPONSES;
    else process.env.DEBUG_DSM_RESPONSES = originalDebug;
  }

  assert.equal(new URLSearchParams(sentBody).get("content"), JSON.stringify(secret));
  const renderedTrace = JSON.stringify(trace);
  assert.doesNotMatch(renderedTrace, /do-not-log/);
  assert.match(renderedTrace, /\*\*\*/);
});

test("sensitive DSM errors omit response content from traces and exceptions", async () => {
  const client = sessionClient();
  const secret = "PASSWORD: do-not-log";
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  const trace: unknown[][] = [];
  globalThis.fetch = (async () => ({
    json: async () => ({
      success: false,
      error: { code: 1202, errors: [{ content: secret }] },
    }),
  })) as typeof fetch;
  console.error = (...args: unknown[]) => trace.push(args);

  try {
    await assert.rejects(
      client.call({
        api: "SYNO.Docker.Project",
        method: "update",
        post: true,
        sensitiveResponse: true,
      }),
      (err: unknown) => {
        assert.ok(err instanceof SynologyApiError);
        assert.equal(err.errors, undefined);
        assert.doesNotMatch(err.message, /do-not-log/);
        return true;
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalError;
  }

  const renderedTrace = JSON.stringify(trace);
  assert.doesNotMatch(renderedTrace, /do-not-log/);
  assert.match(renderedTrace, /code=1202/);
});
