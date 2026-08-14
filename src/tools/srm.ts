/**
 * Synology router (SRM) reads. SRM speaks the same SYNO.* Web API as DSM, but with
 * differences confirmed live against SRM 1.3.1 (RT6600ax):
 *   - login is at auth.cgi with SYNO.API.Auth v3 (DSM uses entry.cgi / v6) — handled
 *     by the router SynoClient's authPath/authVersion (see config.ts).
 *   - package/upgrade reads are admin-gated, so the router account must be a
 *     *dedicated SRM admin* (Control Panel → User → Edit → "Grant administrator
 *     privilege"; a Normal user gets code 402 at login).
 * The router client is constructed read-only (see SynoClient).
 *
 * SRM exposes no package-update API (`SYNO.Core.Package.Server` returns 103),
 * so there is no router package command alongside these reads.
 *
 * Detection only — no SRM writes (the router login uses a dedicated SRM admin
 * credential; a bricked router would also drop this very connection).
 */

import type { SynoClient } from "../client.js";
import { type OsUpdateStatus } from "../types.js";
import { osCheckUpdate } from "./os-check.js";

/** SRM OS-update check. Confirmed live on SRM 1.3.1: the router reuses
 *  `SYNO.Core.Upgrade.Server check` v1 and returns DSM's flat `{available, version}`
 *  shape, so the shared osCheckUpdate handles it unchanged. The one difference from
 *  DSM is the current-version read: `SYNO.Core.System info` at **v1** (v3 is DSM-only
 *  and 104s on SRM). */
export function routerSrmOsCheckUpdate(router: SynoClient): Promise<OsUpdateStatus> {
  return osCheckUpdate(router, 1);
}

interface RouterClientWire {
  mac?: string;
  hostname?: string;
  ip_addr?: string;
  ip6_addr?: string;
  is_online?: boolean;
  connection?: string;
  is_wireless?: boolean;
}

interface RouterClientsWire {
  devices?: RouterClientWire[];
  exceed_dev_list_max?: boolean;
}

function canonicalMac(value: string): string {
  const compact = value.replace(/[:-]/g, "").toLowerCase();
  if (!/^[0-9a-f]{12}$/.test(compact)) {
    throw new Error(`Invalid MAC address "${value}".`);
  }
  return compact.match(/../g)!.join(":");
}

/** SRM has no verified server-side MAC filter, so read the inventory privately
 * and return only the exact match instead of exposing every remembered device. */
export async function routerSrmClients(router: SynoClient, macInput: string) {
  const mac = canonicalMac(macInput);
  const data = await router.call<RouterClientsWire>({
    api: "SYNO.Core.Network.NSM.Device",
    method: "get",
    version: 1,
    params: { filters: JSON.stringify({}) },
    sensitiveResponse: true,
  });
  const match = (data.devices ?? []).find(
    (device) => device.mac && canonicalMac(device.mac) === mac
  );
  return {
    client: match
      ? {
          mac: canonicalMac(match.mac!),
          hostname: match.hostname,
          ipv4: match.ip_addr,
          ipv6: match.ip6_addr,
          online: match.is_online,
          connection: match.connection,
          wireless: match.is_wireless,
        }
      : null,
    source_truncated: data.exceed_dev_list_max ?? false,
  };
}
