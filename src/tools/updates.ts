/**
 * DSM OS update availability.
 *
 *   nas_dsm_os_check_update   — is a DSM OS update available (read-only)
 *
 * Detection only. Applying OS updates is out of scope (brick risk); NAS package
 * updates have the existing interactive nas_package_update.
 *
 * DSM-OS API (corroborated across py-synologydsm-api, N4S4, synoctl, synaudit):
 *   SYNO.Core.Upgrade.Server  check  v1  — GET, _sid auth, SYNCHRONOUS (no poll).
 *   Response: data.update.{available, version, reboot, restart} (+ data.current).
 * The exact field names are worth one HAR sanity-check on the live DSM; mapOsUpdate
 * parses defensively so minor shape drift degrades to `available:false` not a throw.
 */

import type { SynoClient } from "../client.js";
import type { OsUpdateStatus } from "../types.js";
import { osCheckUpdate } from "./os-check.js";

/** DSM OS-update check. Reads the current version from `SYNO.Core.System info`
 *  at **v3** (DSM-only; SRM caps at v1) — the single device-specific knob the
 *  shared osCheckUpdate takes. */
export function nasDsmOsCheckUpdate(dsm: SynoClient): Promise<OsUpdateStatus> {
  return osCheckUpdate(dsm, 3);
}
