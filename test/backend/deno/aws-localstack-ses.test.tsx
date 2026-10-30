// Coverage: real AWS SES email sending against LocalStack (addendum-074).
// Exercises server/email-ses.tsx's SDK-backed sendSesEmail/verifySesEmailAddress/
// getSesStatistics (replacing the former mock), plus the notifyTrigger → SES
// fan-out path writing a 'sent' sent_notifications row.
//
// Requires LocalStack running (`docker compose up -d`) and bootstrapped
// (`deno task localstack:bootstrap`, which pre-verifies the sender identity
// no-reply@ffs.test). Like aws-localstack.test.tsx, this file is NOT part of
// the always-on regression gate — .env.test never sets AWS_ENDPOINT_URL, so
// the whole file self-skips (one "skipped" step, zero real assertions) under
// a normal `deno task test`.
import { assertEquals, assertExists } from "jsr:@std/assert";
import { wipeDatabase, createAdmin } from "./helpers.tsx";
import { notifyTrigger } from "../../../server/email/notify.tsx";
import { processNotificationOutbox } from "../../../server/email/outbox-worker.tsx";
import { sendSesEmail, getSesStatistics, isSesConfigured } from "../../../server/email/ses.tsx";
import { sentNotifications } from "../../../server/db.tsx";
import { setSetting, clearAppSettingsCache } from "../../../server/app-settings.tsx";

const _localstackPort = 4566 + Number(Deno.env.get("E2E_STACK_ID") ?? 0) * 10000;
const LOCALSTACK_ENDPOINT = Deno.env.get("AWS_ENDPOINT_URL") ?? `http://localhost:${_localstackPort}`;
const SES_FROM = "no-reply@ffs.test";
const SES_REGION = "us-east-1";

async function isLocalStackUp(): Promise<boolean> {
  try {
    const res = await fetch(`${LOCALSTACK_ENDPOINT}/_localstack/health`);
    return res.ok;
  } catch {
    return false;
  }
}

async function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void> | void) {
  const prior: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) prior[key] = Deno.env.get(key);
  try {
    for (const [key, value] of Object.entries(vars)) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
    await fn();
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  }
}

async function configureSesSettings(): Promise<void> {
  await setSetting("ses_region", SES_REGION);
  await setSetting("ses_from_address", SES_FROM);
  await setSetting("email_delivery_enabled", "true");
  await setSetting("email_delivery_provider", "ses");
  clearAppSettingsCache();
}

async function resetSesSettings(): Promise<void> {
  await setSetting("ses_region", "");
  await setSetting("ses_from_address", "");
  await setSetting("email_delivery_enabled", "false");
  await setSetting("email_delivery_provider", "disabled");
  clearAppSettingsCache();
}

Deno.test("aws-localstack-ses", async (t) => {
  const localStackUp = await isLocalStackUp();

  await t.step("setup", async () => {
    if (!localStackUp) {
      console.warn(
        "[aws-localstack-ses] LocalStack not reachable at " + LOCALSTACK_ENDPOINT +
        " — skipping this file's real SES round-trip tests. Run `docker compose up -d` " +
        "then `deno task localstack:bootstrap` to enable it.",
      );
      return;
    }
    await wipeDatabase();
    await createAdmin();
    await configureSesSettings();
  });

  if (!localStackUp) return;

  const envVars = {
    AWS_ENDPOINT_URL: LOCALSTACK_ENDPOINT,
    AWS_CREDENTIAL_STRATEGY: "static",
    AWS_ACCESS_KEY_ID: "test",
    AWS_SECRET_ACCESS_KEY: "test",
    AWS_REGION: SES_REGION,
  };

  await t.step("sendSesEmail: positive — real SendEmail round trip against LocalStack", async () => {
    await withEnv(envVars, async () => {
      assertEquals(await isSesConfigured(), true);
      const response = await sendSesEmail({
        subject: "LocalStack SES test",
        body: "<p>Hello from the LocalStack SES test suite.</p>",
        recipient: "recipient@ffs.test",
      });
      assertExists(response, "sendSesEmail returned null — did LocalStack accept the send?");
      assertExists(response!.messageId);
      assertEquals(typeof response!.messageId, "string");
    });
  });

  await t.step("getSesStatistics: positive — returns a sendDataPoints array after a real send", async () => {
    await withEnv(envVars, async () => {
      const stats = await getSesStatistics();
      assertExists(stats);
      assertExists(Array.isArray((stats as any).sendDataPoints));
    });
  });

  await t.step("notifyTrigger: end-to-end — SES provider marks the sent_notifications row 'sent' with a message id", async () => {
    await withEnv(envVars, async () => {
      const admin = await createAdmin("SesAdmin!2026");
      await notifyTrigger("user.approved", ["approvee@ffs.test"], { full_name: "LocalStack Approvee" }, {
        targetType: "user", targetId: admin.id,
      });
      const beforeWorker = await sentNotifications.list(10);
      const staged = beforeWorker.find((row) =>
        row.recipients.some((recipient) => recipient.emailSnapshot === "approvee@ffs.test")
      );
      assertExists(staged);
      assertEquals(staged.deliveries[0]?.status, "pending");
      await processNotificationOutbox({ workerId: "ses-test-worker" });
      const rows = await sentNotifications.list(10);
      const row = rows.find(
        (candidate) => candidate.triggerKey === "user.approved"
          && candidate.recipients.some(
            (recipient) => recipient.emailSnapshot === "approvee@ffs.test",
          ),
      );
      assertExists(row, "expected a sent_notifications header row for the SES-sent notification");
      const delivery = row.deliveries.find(
        (candidate) => candidate.channel === "email"
          && candidate.destination === "approvee@ffs.test",
      );
      assertExists(delivery, "expected the SES email delivery child row");
      assertEquals(delivery.status, "sent");
      const attempt = delivery.attempts?.find((candidate) => candidate.provider === "ses");
      assertExists(attempt, "expected the SES provider attempt child row");
      assertExists(
        attempt.providerMessageId,
        "expected the real SES MessageId in provider_message_id",
      );
    });
  });

  await t.step("cleanup — restore log-only baseline", async () => {
    await resetSesSettings();
  });
});
