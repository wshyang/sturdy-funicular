// Real SMTP send via Nodemailer against the Mailpit fake-SMTP sink
// (docker-compose `mailpit` service, addendum-085). Mailpit accepts SMTP on
// 127.0.0.1:1025 with no auth and exposes a REST API on :8025 that this test
// queries to assert what was actually delivered — the same "real sink, not an
// in-process mock" pattern as the postgres/localstack-backed suites. Asserts
// sendSmtpEmail round-trips: the response returns the accepted recipient + a
// messageId, Mailpit captures the envelope + body, and an unreachable port
// returns null (not a throw).
import { assertEquals, assertExists, assertMatch } from "jsr:@std/assert";
import { wipeDatabase } from "./helpers.tsx";
import { setSetting, clearAppSettingsCache } from "../../../server/app-settings.tsx";
import { sendSmtpEmail, getSmtpConfig } from "../../../server/email/smtp.tsx";
import {
  getPostmanEmailStatus,
  isPostmanConfigured,
  sendPostmanEmail,
} from "../../../server/email/postman.tsx";
import { query } from "../../../server/pg.tsx";
import { mailpitClear, mailpitWaitFor, mailpitMessage } from "./helpers-mailpit.ts";

const MAILPIT_SMTP_HOST = "127.0.0.1";
const MAILPIT_SMTP_PORT = Deno.env.get("MAILPIT_SMTP_PORT") ??
  String(1025 + Number(Deno.env.get("E2E_STACK_ID") ?? 0) * 10000);

async function resetSmtpSettings(overrides: Record<string, string> = {}) {
  const base: Record<string, string> = {
    smtp_host: "", smtp_port: "587", smtp_username: "", smtp_password: "",
    smtp_from: "", smtp_secure: "false",
  };
  for (const [k, v] of Object.entries({ ...base, ...overrides })) {
    await setSetting(k, v);
  }
  clearAppSettingsCache();
}

Deno.test("smtp: real send against the Mailpit fake SMTP server", async (t) => {
  await t.step("setup: point settings at Mailpit and clear its inbox", async () => {
    await wipeDatabase();
    await mailpitClear();
    // username/password are non-empty because getSmtpConfig requires them, but
    // Mailpit does not advertise AUTH so Nodemailer never sends credentials.
    await resetSmtpSettings({
      smtp_host: MAILPIT_SMTP_HOST, smtp_port: MAILPIT_SMTP_PORT,
      smtp_username: "test", smtp_password: "test", smtp_from: "sender@test.local",
    });
  });

  await t.step("getSmtpConfig resolves from the app settings", async () => {
    const cfg = await getSmtpConfig();
    assertExists(cfg);
    assertEquals(cfg!.host, MAILPIT_SMTP_HOST);
    assertEquals(cfg!.port, Number(MAILPIT_SMTP_PORT));
    assertEquals(cfg!.secure, false);
  });

  await t.step("sendSmtpEmail round-trips through Mailpit", async () => {
    const res = await sendSmtpEmail({
      subject: "SMTP Test",
      body: "<p>Hello from the SMTP test</p>",
      recipient: "recipient@test.local",
    });
    assertExists(res, "expected a successful SMTP send");
    assertEquals(res!.accepted, ["recipient@test.local"]);
    assertEquals(res!.rejected, []);
    assertMatch(res!.messageId ?? "", /@/);

    // Mailpit's REST API captured exactly the one message with our envelope.
    const list = await mailpitWaitFor(1);
    assertEquals(list.messages_count, 1);
    const summary = list.messages[0];
    assertEquals(summary.From.Address, "sender@test.local");
    assertEquals(summary.To.map((r) => r.Address), ["recipient@test.local"]);
    assertEquals(summary.Subject, "SMTP Test");

    const full = await mailpitMessage(summary.ID);
    assertMatch(full.HTML, /Hello from the SMTP test/);
  });

  await t.step("failure path: unreachable port returns null (not a throw)", async () => {
    await resetSmtpSettings({
      smtp_port: "1", smtp_host: MAILPIT_SMTP_HOST,
      smtp_username: "test", smtp_password: "test", smtp_from: "sender@test.local",
    });
    const res = await sendSmtpEmail({
      subject: "x", body: "x", recipient: "nobody@test.local",
    });
    assertEquals(res, null);
  });

  await t.step("cleanup: reset settings", async () => {
    await resetSmtpSettings();
  });
});

// G5 (addendum-140, executed addendum-141): the postman.gov.sg delivery
// branch was the one provider family with zero pins (smtp has Mailpit, SES
// has localstack). Postman.gov.sg has no fake sink here, so the pin is the
// FAIL-CLOSED contract every provider must keep: unconfigured means
// nulls/false, never a throw — the same idiom as sendSmtpEmail's
// unreachable-port arm above and sendSlackDM's gating.
Deno.test("postman provider: unconfigured send path fails closed (G5)", async (t) => {
  await t.step("setup: wipe + strip every postman_* setting", async () => {
    await wipeDatabase();
    await query(
      `UPDATE app_settings SET value = '' WHERE key IN
       ('postman_api_key','postman_default_from','postman_default_classification')`,
    );
    clearAppSettingsCache();
  });

  await t.step("isPostmanConfigured() reports false; send returns null (never throws)", async () => {
    assertEquals(await isPostmanConfigured(), false);
    const res = await sendPostmanEmail({
      subject: "G5 pin", body: "should never leave the box", recipient: "nobody@test.local",
    });
    assertEquals(res, null);
  });

  await t.step("status polling is fail-closed too", async () => {
    assertEquals(await getPostmanEmailStatus("email-id-that-never-existed"), null);
  });
});
