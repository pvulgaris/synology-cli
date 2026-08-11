import { test } from "node:test";
import assert from "node:assert/strict";
import { nasNotifications } from "./notifications.js";
import type { SynoClient, SynologyCallOptions } from "../client.js";

function mailClient(
  respond: (version: number) => Promise<Record<string, unknown>>
): SynoClient {
  return {
    call: async (options: SynologyCallOptions) => {
      assert.equal(options.api, "SYNO.Core.Notification.Mail.Conf");
      return respond(options.version ?? 1);
    },
  } as SynoClient;
}

test("notifications: v2 recipient profiles are preferred over the v1 mail list", async () => {
  const result = await nasNotifications(
    mailClient(async () => ({
      enable_mail: true,
      smtp_info: { server: "smtp.test", port: 587, ssl: true, verifyCert: true },
      profiles: [
        { target_type: "mail", target_name: "Home Alert", target_config: { mail: "ops@test" } },
        { target_type: "sms", target_name: "phone" },
      ],
    }))
  );
  assert.deepEqual(result.mail?.recipients, ["ops@test"]);
  assert.equal(result.mail?.recipients_count, 1);
  assert.deepEqual(result.warnings, []);
});

test("notifications: a v2 failure falls back to v1 without a warning", async () => {
  const result = await nasNotifications(
    mailClient(async (version) => {
      if (version === 2) throw new Error("v2 unsupported");
      return { enable_mail: true, mail: ["ops@test"] };
    })
  );
  assert.equal(result.mail?.recipients_count, 1);
  assert.deepEqual(result.warnings, []);
});

test("notifications: a partial payload keeps its SMTP fields and still warns", async () => {
  // A response can fail the usability check and still carry the fields an audit
  // reads. Dropping the block would silently retire synology.notifications
  // .smtp_verify_cert_off on any DSM build that answers this way.
  const result = await nasNotifications(
    mailClient(async () => ({
      smtp_info: { server: "smtp.test", port: 25, ssl: false, verifyCert: false },
      sender_mail: "nas@test",
    }))
  );
  assert.equal(result.mail?.verify_cert, false);
  assert.equal(result.mail?.sender, "nas@test");
  assert.equal(result.warnings.length, 1);
});

test("notifications: an empty payload is reported, not read as 'no SMTP'", async () => {
  // Some DSM builds answer an unknown version with a bare `success` and no data.
  // Without the warning that is indistinguishable from a NAS with mail turned off.
  const result = await nasNotifications(mailClient(async () => ({})));
  assert.deepEqual(result.warnings, [
    {
      source: "mail_config_v1",
      error: "SYNO.Core.Notification.Mail.Conf returned no usable config.",
    },
  ]);
});

test("notifications: a failed read is named in the warnings", async () => {
  const result = await nasNotifications(
    mailClient(async () => {
      throw new Error("Mail.Conf unavailable");
    })
  );
  assert.equal(result.mail, null);
  assert.deepEqual(
    result.warnings.map((warning) => warning.source),
    ["mail_config_v2", "mail_config_v1"]
  );
});
