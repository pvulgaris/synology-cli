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
 * The only named operation here checks for an SRM OS update. SRM exposes no
 * package-update API, so the aggregate digest reports that capability without
 * probing a known-absent endpoint.
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
