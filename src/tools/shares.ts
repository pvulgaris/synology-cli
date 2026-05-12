/**
 * Shared-folder inspection.
 *
 * SYNO.Core.Share — list with additional fields. The DSM 7 response uses
 * `enable_recycle_bin` (not `recyclebin`) on the read side, even though the
 * request additional[] key is `recyclebin`. Time Machine flag is NOT on this
 * API in DSM 7 — TM folder selection lives under a separate File Services
 * endpoint and would need its own tool.
 */

import type { DsmClient } from "../dsm.js";

export async function nasSharesList(dsm: DsmClient) {
  const data = await dsm.call({
    api: "SYNO.Core.Share",
    method: "list",
    version: 1,
    params: {
      shareType: "all",
      additional:
        '["hidden","encryption","is_aclmode","unite_permission","is_support_acl","is_sync_share","is_force_readonly","force_readonly_reason","recyclebin","share_quota","enable_share_cow","enable_share_compress","support_snapshot"]',
    },
  });
  return {
    shares: (data?.shares ?? []).map((s: any) => ({
      name: s.name,
      path: s.path,
      vol_path: s.vol_path,
      enabled: !s.disable,
      encryption: s.additional?.encryption,
      hidden: s.additional?.hidden,
      quota_mb: s.additional?.share_quota,
      recycle_bin: s.additional?.enable_recycle_bin ?? s.additional?.recyclebin,
      btrfs_cow: s.additional?.enable_share_cow,
      support_snapshot: s.additional?.support_snapshot,
      force_readonly: s.additional?.is_force_readonly,
    })),
  };
}
