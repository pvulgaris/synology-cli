/** Unit coverage for the SRM OS update read. */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SynoClient, SynologyCallOptions } from "../client.js";
import { routerSrmClients, routerSrmOsCheckUpdate } from "./srm.js";

function fakeClient(handlers: Record<string, (params: Record<string, unknown>) => unknown>): SynoClient {
  const call = async (opts: SynologyCallOptions): Promise<unknown> => {
    const key = `${opts.api}.${opts.method}`;
    const h = handlers[key];
    if (!h) throw new Error(`unexpected DSM call: ${key}`);
    return h((opts.params ?? {}) as Record<string, unknown>);
  };
  return { call } as unknown as SynoClient;
}

test("router OS: maps the live SRM update shape (1.3.1 → 1.3.2)", async () => {
  const router = fakeClient({
    "SYNO.Core.System.info": () => ({ firmware_ver: "SRM 1.3.1-9346 Update 13" }),
    "SYNO.Core.Upgrade.Server.check": () => ({ available: true, version: "SRM 1.3.2-9366" }),
  });

  const o = await routerSrmOsCheckUpdate(router);

  assert.equal(o.available, true);
  assert.equal(o.current_version, "SRM 1.3.1-9346 Update 13");
  assert.equal(o.available_version, "SRM 1.3.2-9366");
});

test("router OS: System.info failure degrades current_version to null, still reports availability", async () => {
  const router = fakeClient({
    // The .catch in routerSrmOsCheckUpdate must absorb this into a warning.
    "SYNO.Core.System.info": () => { throw new Error("code 104"); },
    "SYNO.Core.Upgrade.Server.check": () => ({ available: false }),
  });

  const o = await routerSrmOsCheckUpdate(router);

  assert.equal(o.current_version, null);
  assert.equal(o.available, false);
  // A null current_version from a *failed* read must be distinguishable from a
  // genuinely-absent one, so the digest doesn't present it as known.
  assert.match(o.warning ?? "", /current-version read failed/);
});

test("router clients: returns only the requested MAC from the private inventory read", async () => {
  const calls: SynologyCallOptions[] = [];
  const router = {
    call: async (opts: SynologyCallOptions) => {
      calls.push(opts);
      return {
        devices: [
          { mac: "aa:bb:cc:dd:ee:ff", hostname: "other", ip_addr: "192.0.2.1" },
          {
            mac: "02:11:32:26:84:91",
            hostname: "haos",
            ip_addr: "192.0.2.2",
            ip6_addr: "2001:db8::2",
            is_online: true,
            connection: "ethernet",
            is_wireless: false,
          },
        ],
        exceed_dev_list_max: false,
      };
    },
  } as unknown as SynoClient;

  const result = await routerSrmClients(router, "02-11-32-26-84-91");

  assert.deepEqual(result.client, {
    mac: "02:11:32:26:84:91",
    hostname: "haos",
    ipv4: "192.0.2.2",
    ipv6: "2001:db8::2",
    online: true,
    connection: "ethernet",
    wireless: false,
  });
  assert.deepEqual(calls[0].params, { filters: "{}" });
  assert.equal(calls[0].sensitiveResponse, true);
});

test("router clients: rejects malformed MACs before reading the inventory", async () => {
  let called = false;
  const router = {
    call: async () => {
      called = true;
      return {};
    },
  } as unknown as SynoClient;

  await assert.rejects(() => routerSrmClients(router, "not-a-mac"), /Invalid MAC address/);
  assert.equal(called, false);
});
