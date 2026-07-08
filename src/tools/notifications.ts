/**
 * Notification posture: SMTP / Push config + whether anyone will hear alarms.
 *
 * Security Advisor's `rule_notify_download_ready_v3` reliably flags when this
 * is broken, but the audit composition wants the underlying state so it can
 * distinguish "no SMTP at all" from "SMTP wired up but no recipients" from
 * "SMTP fine, just verify-cert is off."
 */

import type { SynoClient } from "../dsm.js";

export async function nasNotifications(dsm: SynoClient) {
  // DSM 7.3 exposes recipients only at Mail.Conf v2 (a `profiles` list —
  // "Recipient Profiles" in the UI); v1 reports `mail: []` regardless, which
  // read as "no recipients" even when one was configured. Older DSM predating
  // 7.3 may not serve v2 at all, so try v2 first and fall back to a real v1
  // call — otherwise a v2-unsupported error would null the whole block and
  // drop the SMTP fields too, a regression from the always-worked v1 call.
  const getMailConf = (version: number) =>
    dsm.call({ api: "SYNO.Core.Notification.Mail.Conf", method: "get", version }).catch(() => null);
  // Only accept a v2 payload that actually carries config — some DSM builds
  // answer an unknown version with a bare `success`/`{}` rather than an error,
  // and that truthy `{}` must not shadow the v1 fallback (which would drop the
  // SMTP fields too, not just recipients).
  const usable = (m: { enable_mail?: unknown; profiles?: unknown } | null) =>
    !!m && (m.enable_mail !== undefined || Array.isArray(m.profiles));
  const v2 = await getMailConf(2);
  const mail = usable(v2) ? v2 : await getMailConf(1);
  // Recipients live in `profiles` on DSM 7.3 (target_type "mail"), in the flat
  // `mail` array pre-7.3. Prefer the authoritative address `target_config.mail`
  // over the `target_name` display label (a profile can be named "Home Alert");
  // `||` (not `??`) so an empty-string address still falls back to the label
  // before the length filter drops truly-empty entries.
  const hasProfiles = Array.isArray(mail?.profiles);
  const hasMailList = Array.isArray(mail?.mail);
  const recipients: string[] = hasProfiles
    ? mail.profiles
        .filter((p: { target_type?: string }) => p?.target_type === "mail")
        .map(
          (p: { target_name?: string; target_config?: { mail?: string } }) =>
            p?.target_config?.mail || p?.target_name
        )
        .filter((x: unknown): x is string => typeof x === "string" && x.length > 0)
    : hasMailList
      ? mail.mail
      : [];
  return {
    mail: mail
      ? {
          enabled: mail.enable_mail,
          oauth: mail.enable_oauth,
          smtp_server: mail.smtp_info?.server,
          smtp_port: mail.smtp_info?.port,
          ssl: mail.smtp_info?.ssl,
          verify_cert: mail.smtp_info?.verifyCert,
          sender: mail.sender_mail,
          subject_prefix: mail.subject_prefix,
          // Recipients who actually receive alarms. `null` = response shape
          // indeterminate (neither profiles nor mail list present); 0 = SMTP
          // configured but no human is set to receive the message.
          recipients_count: hasProfiles || hasMailList ? recipients.length : null,
          recipients,
          in_use: mail.in_use ?? null,
        }
      : null,
  };
}
