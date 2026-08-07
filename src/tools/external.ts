/**
 * External-access posture: what's reachable from outside the LAN?
 *
 * QuickConnect, DDNS, port forwarding, reverse-proxy rules, and Application
 * Portal HTTPS-per-app config. None of this is on the audit-critical path
 * for a Tailscale-only NAS, but for any NAS that's ever been internet-facing
 * these are the highest-impact misconfigs (RISK:STATION, Diskstation gang,
 * StealthWorker botnet all target this surface).
 */

import type { SynoClient } from "../client.js";
import { readSource, readWarnings } from "./partial.js";

export async function nasExternalAccess(dsm: SynoClient) {
  const sources = await Promise.all([
    readSource("quick_connect", () =>
      dsm.call({ api: "SYNO.Core.QuickConnect", method: "get", version: 2 })
    ),
    readSource("quick_connect_misc", () =>
      dsm.call({ api: "SYNO.Core.QuickConnect", method: "get_misc_config", version: 3 })
    ),
    readSource("ddns", () =>
      dsm.call({ api: "SYNO.Core.DDNS.Record", method: "list", version: 1 })
    ),
    readSource("reverse_proxy", () =>
      dsm.call({ api: "SYNO.Core.AppPortal.ReverseProxy", method: "list", version: 1 })
    ),
    readSource("app_portal", () =>
      dsm.call({ api: "SYNO.Core.AppPortal", method: "list", version: 2 })
    ),
    readSource("port_forwarding", () =>
      dsm.call<any[]>({ api: "SYNO.Core.PortForwarding.Rules", method: "load", version: 1 })
    ),
  ]);
  const [qc, qcMisc, ddns, reverseProxy, appPortal, portForwarding] = sources.map(
    (source) => source.value as any
  );
  return {
    quick_connect: qc
      ? {
          enabled: qc.enabled,
          relay_enabled: qcMisc?.relay_enabled ?? null,
          server_alias: qc.server_alias || null,
          myds_account: qc.myds_account || null,
          server_id: qc.server_id || null,
          region: qc.region,
        }
      : null,
    ddns_records: ddns?.records ?? [],
    reverse_proxy_entries: reverseProxy?.entries ?? [],
    app_portal: (appPortal?.portal ?? []).map((a: any) => ({
      id: a.id,
      display_name: a.display_name,
      enable_redirect: a.enable_redirect,
    })),
    port_forwarding: Array.isArray(portForwarding) ? portForwarding : (portForwarding as any)?.rules ?? null,
    warnings: readWarnings(sources),
  };
}
