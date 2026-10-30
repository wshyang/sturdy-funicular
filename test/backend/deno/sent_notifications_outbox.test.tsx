// Coverage: server/email-notify.tsx's notifyTrigger()/resolveTeamEmails()/
// resolveTeamEmailsById(). See addendum-044-email-notifications.md.
import { assertEquals, assertExists, assertRejects } from "jsr:@std/assert";
import { wipeDatabase, createAdmin, createActiveUser, createCluster, createTeam, addMember, uniqueEmail } from "./helpers.tsx";
import { notifyTrigger, resolveTeamEmails, resolveTeamEmailsById } from "../../../server/email/notify.tsx";
import { processNotificationOutbox } from "../../../server/email/outbox-worker.tsx";
import { notificationTemplates, sentNotifications } from "../../../server/db.tsx";
import { setSetting, clearAppSettingsCache } from "../../../server/app-settings.tsx";
import { query, runInTransaction } from "../../../server/pg.tsx";
import { mailpitClear, mailpitMessages, mailpitWaitFor } from "./helpers-mailpit.ts";

Deno.test("sent_notifications outbox / notifyTrigger", async (t) => {
  let adminId: string;

  await t.step("setup", async () => {
    await wipeDatabase();
    const admin = await createAdmin();
    adminId = admin.id;
  });

  await t.step("notifyTrigger: positive — writes one sent_notifications row with the rendered snapshot", async () => {
    const template = await notificationTemplates.findByTriggerKey("user.approved");
    assertExists(template);
    await notifyTrigger("user.approved", ["recipient@test.local"], { full_name: "Erin" }, {
      targetType: "user", targetId: adminId,
    });
    const rows = await sentNotifications.list(10);
    const row = rows.find((r) => r.triggerKey === "user.approved");
    assertExists(row);
    assertEquals(
      row.recipients.map((recipient) => recipient.emailSnapshot),
      ["recipient@test.local"],
    );
    assertEquals(row.deliveries.every((delivery) => delivery.status === "logged"), true);
    for (const forbidden of [
      "recipientEmails",
      "subject",
      "bodyHtml",
      "status",
      "providerMessageId",
    ]) {
      assertEquals(forbidden in row, false, `${forbidden} must not be projected on the root`);
    }
    assertEquals(row!.relatedTargetType, "user");
    assertEquals(row!.relatedTargetId, adminId);
  });

  await t.step("staging joins the business transaction and rolls back with it", async () => {
    const before = (await sentNotifications.list(1000)).length;
    await assertRejects(
      () => runInTransaction(async () => {
        await notifyTrigger(
          "user.rejected",
          ["rollback@test.local"],
          { full_name: "Rollback" },
        );
        throw new Error("force business rollback");
      }),
      Error,
      "force business rollback",
    );
    const after = (await sentNotifications.list(1000)).length;
    assertEquals(after, before);
  });

  await t.step("notifyTrigger: negative — empty recipient list is a silent no-op", async () => {
    const before = (await sentNotifications.list(1000)).length;
    await notifyTrigger("user.rejected", [], { full_name: "Frank" });
    const after = (await sentNotifications.list(1000)).length;
    assertEquals(after, before);
  });

  await t.step("notifyTrigger: negative — no active template is a silent no-op", async () => {
    const template = await notificationTemplates.findByTriggerKey("user.tombstoned");
    assertExists(template);
    await notificationTemplates.update(template!.id, { isActive: false });
    try {
      const before = (await sentNotifications.list(1000)).length;
      await notifyTrigger("user.tombstoned", ["recipient@test.local"], { full_name: "Gina" });
      const after = (await sentNotifications.list(1000)).length;
      assertEquals(after, before);
    } finally {
      await notificationTemplates.update(template!.id, { isActive: true });
    }
  });

  // Regression: the delivery loop used to `break` after the first successful
  // send, so with 2+ recipients only the first one actually received the
  // email. The fixed loop delivers to EVERY recipient and marks the header
  // 'sent'. addendum-085 replaced the former in-process log-mock with real
  // Nodemailer, so this points the SMTP provider at the Mailpit sink
  // (docker-compose `mailpit`) and asserts via its REST API that BOTH
  // recipients received a message.
  await t.step("notifyTrigger: multi-recipient — delivers to EVERY recipient when the provider is configured", async () => {
    await mailpitClear();
    await setSetting("email_delivery_enabled", "true");
    await setSetting("email_delivery_provider", "smtp");
    await setSetting("smtp_host", "127.0.0.1");
    await setSetting("smtp_port", "1025");
    await setSetting("smtp_username", "test");
    await setSetting("smtp_password", "test");
    await setSetting("smtp_from", "no-reply@test.local");
    clearAppSettingsCache();

    await notifyTrigger("user.approved", ["alice@test.local", "bob@test.local"], { full_name: "Erin" });

    const stagedRows = await sentNotifications.list(10);
    const staged = stagedRows.find(
      (candidate) => candidate.triggerKey === "user.approved"
        && candidate.recipients.some(
          (recipient) => recipient.emailSnapshot === "alice@test.local",
        ),
    );
    assertExists(staged);
    assertEquals(staged.deliveries.every((delivery) => delivery.status === "pending"), true);
    assertEquals(staged.deliveries.flatMap((delivery) => delivery.attempts ?? []), []);
    assertEquals((await mailpitMessages()).messages_count, 0, "producer must perform no provider IO");

    const processed = await processNotificationOutbox({ workerId: "test-worker" });
    assertEquals(processed.claimed, 2);
    assertEquals(processed.sent, 2);
    assertEquals(processed.failed, 0);

    // Mailpit captured one message per recipient (proves the worker does not
    // stop after the first send).
    const list = await mailpitWaitFor(2);
    assertEquals(list.messages_count, 2, "expected one SMTP send per recipient");
    const recipients = list.messages.flatMap((m) => m.To.map((r) => r.Address)).sort();
    assertEquals(recipients, ["alice@test.local", "bob@test.local"]);

    const rows = await sentNotifications.list(10);
    const row = rows.find((candidate) => candidate.id === staged.id);
    assertExists(row);
    assertEquals(
      row.recipients.map((recipient) => recipient.emailSnapshot),
      ["alice@test.local", "bob@test.local"],
    );
    assertEquals(row.deliveries.every((delivery) => delivery.status === "sent"), true);
    assertEquals(row.deliveries.some((delivery) => delivery.status === "pending"), false);
    assertExists(row.deliveries.flatMap((d) => d.attempts ?? []).find((a) => a.provider === "smtp")?.providerMessageId);

    // Restore the log-only baseline.
    await setSetting("email_delivery_enabled", "false");
    await setSetting("email_delivery_provider", "disabled");
    clearAppSettingsCache();
  });

  await t.step("worker retries provider failures and terminally fails at the cap", async () => {
    await setSetting("email_delivery_enabled", "true");
    await setSetting("email_delivery_provider", "smtp");
    await setSetting("smtp_host", "127.0.0.1");
    await setSetting("smtp_port", "1");
    clearAppSettingsCache();

    await notifyTrigger(
      "user.approved",
      ["retry@test.local"],
      { full_name: "Retry" },
    );
    const first = await processNotificationOutbox({
      workerId: "retry-worker-1",
      maxAttempts: 2,
      retryBaseMs: 0,
    });
    assertEquals(first.retried, 1);
    assertEquals(first.failed, 0);

    const pendingRows = await sentNotifications.list(10);
    const pending = pendingRows.find((row) =>
      row.recipients.some((recipient) => recipient.emailSnapshot === "retry@test.local")
    );
    assertExists(pending);
    assertEquals(pending.deliveries[0]?.status, "pending");
    assertEquals(pending.deliveries[0]?.attemptCount, 1);
    assertEquals(pending.deliveries[0]?.attempts?.length, 1);
    assertEquals(pending.deliveries[0]?.attempts?.[0]?.status, "failed");
    assertEquals(pending.deliveries.some((delivery) => delivery.status === "sent"), false);
    await query(
      `UPDATE notification_deliveries
          SET next_attempt_at = now() - interval '1 second'
        WHERE id = $1`,
      [pending.deliveries[0]!.id],
    );

    const second = await processNotificationOutbox({
      workerId: "retry-worker-2",
      maxAttempts: 2,
      retryBaseMs: 0,
    });
    assertEquals(second.failed, 1);
    assertEquals(second.retried, 0);

    const final = await sentNotifications.get(pending.id);
    assertExists(final);
    assertEquals(final.deliveries[0]?.status, "failed");
    assertEquals(final.deliveries[0]?.attemptCount, 2);
    assertEquals(final.deliveries[0]?.attempts?.length, 2);
    assertEquals(
      (await processNotificationOutbox({ workerId: "retry-worker-3" })).claimed,
      0,
    );

    await setSetting("email_delivery_enabled", "false");
    await setSetting("email_delivery_provider", "disabled");
    clearAppSettingsCache();
  });

  await t.step("concurrent workers claim one delivery at most once", async () => {
    await mailpitClear();
    await setSetting("email_delivery_enabled", "true");
    await setSetting("email_delivery_provider", "smtp");
    await setSetting("smtp_host", "127.0.0.1");
    await setSetting("smtp_port", "1025");
    clearAppSettingsCache();

    await notifyTrigger(
      "user.approved",
      ["single-claim@test.local"],
      { full_name: "Single Claim" },
    );
    const runs = await Promise.all([
      processNotificationOutbox({ workerId: "concurrent-a" }),
      processNotificationOutbox({ workerId: "concurrent-b" }),
    ]);
    assertEquals(runs.reduce((sum, run) => sum + run.claimed, 0), 1);
    assertEquals((await mailpitWaitFor(1)).messages_count, 1);

    const rows = await sentNotifications.list(10);
    const row = rows.find((candidate) =>
      candidate.recipients.some(
        (recipient) => recipient.emailSnapshot === "single-claim@test.local",
      )
    );
    assertExists(row);
    assertEquals(row.deliveries[0]?.status, "sent");
    assertEquals(row.deliveries[0]?.attempts?.length, 1);

    await setSetting("email_delivery_enabled", "false");
    await setSetting("email_delivery_provider", "disabled");
    clearAppSettingsCache();
  });

  await t.step("a fresh claim is protected and a stale claim is recoverable", async () => {
    await mailpitClear();
    await setSetting("email_delivery_enabled", "true");
    await setSetting("email_delivery_provider", "smtp");
    await setSetting("smtp_host", "127.0.0.1");
    await setSetting("smtp_port", "1025");
    clearAppSettingsCache();

    await notifyTrigger(
      "user.approved",
      ["stale-claim@test.local"],
      { full_name: "Stale Claim" },
    );
    const stagedRows = await sentNotifications.list(10);
    const staged = stagedRows.find((row) =>
      row.recipients.some(
        (recipient) => recipient.emailSnapshot === "stale-claim@test.local",
      )
    );
    assertExists(staged);
    const deliveryId = staged.deliveries[0]!.id;
    await query(
      `UPDATE notification_deliveries
          SET claimed_at = now(), claimed_by = 'dead-worker'
        WHERE id = $1`,
      [deliveryId],
    );

    const protectedRun = await processNotificationOutbox({
      workerId: "recovery-worker-early",
      claimTtlMs: 300_000,
    });
    assertEquals(protectedRun.claimed, 0);
    assertEquals((await mailpitMessages()).messages_count, 0);

    await query(
      `UPDATE notification_deliveries
          SET claimed_at = now() - interval '10 minutes'
        WHERE id = $1`,
      [deliveryId],
    );
    const recoveredRun = await processNotificationOutbox({
      workerId: "recovery-worker",
      claimTtlMs: 300_000,
    });
    assertEquals(recoveredRun.claimed, 1);
    assertEquals(recoveredRun.sent, 1);
    assertEquals((await mailpitWaitFor(1)).messages_count, 1);

    const recovered = await sentNotifications.get(staged.id);
    assertExists(recovered);
    assertEquals(recovered.deliveries[0]?.status, "sent");
    assertEquals(recovered.deliveries[0]?.claimedBy, null);

    await setSetting("email_delivery_enabled", "false");
    await setSetting("email_delivery_provider", "disabled");
    clearAppSettingsCache();
  });

  await t.step("multi-channel: notifyTrigger writes per-recipient notification_deliveries rows (addendum-073)", async () => {
    await notifyTrigger("user.approved", ["carol@test.local", "dave@test.local"], { full_name: "Carol" });
    const headers = await sentNotifications.list(10);
    const header = headers.find(
      (candidate) => candidate.triggerKey === "user.approved"
        && candidate.recipients.some(
          (recipient) => recipient.emailSnapshot === "carol@test.local",
        ),
    );
    assertExists(header);
    const deliveries = header!.deliveries;
    // Log-only mode → one 'logged' email delivery per recipient.
    assertEquals(deliveries.length, 2);
    assertEquals(deliveries.every((d) => d.channel === "email"), true);
    assertEquals(deliveries.every((d) => d.status === "logged"), true);
    assertEquals(deliveries.map((d) => d.destination).sort(), ["carol@test.local", "dave@test.local"]);
  });

  await t.step("resolveTeamEmails: positive — returns active members' emails", async () => {
    const cluster = await createCluster("vendor", adminId);
    const team = await createTeam(cluster, 2, adminId);
    const member = await createActiveUser({ fullName: "Helen", email: uniqueEmail("helen"), password: "Pass!2026", affiliation: "vendor" });
    await addMember(team, member, adminId);

    const emails = await resolveTeamEmails(cluster.id, 2);
    assertEquals(emails, [member.email]);
  });

  await t.step("resolveTeamEmails: edge — a team with zero members returns an empty array, not a throw", async () => {
    const cluster = await createCluster("agency", adminId);
    await createTeam(cluster, 1, adminId);
    const emails = await resolveTeamEmails(cluster.id, 1);
    assertEquals(emails, []);
  });

  await t.step("resolveTeamEmails: edge — no team at (cluster, level) returns an empty array", async () => {
    const cluster = await createCluster("vendor", adminId);
    const emails = await resolveTeamEmails(cluster.id, 5);
    assertEquals(emails, []);
  });

  await t.step("resolveTeamEmailsById: positive — matches resolveTeamEmails for the same team", async () => {
    const cluster = await createCluster("vendor", adminId);
    const team = await createTeam(cluster, 3, adminId);
    const member = await createActiveUser({ fullName: "Ivan", email: uniqueEmail("ivan"), password: "Pass!2026", affiliation: "vendor" });
    await addMember(team, member, adminId);

    const byId = await resolveTeamEmailsById(team.id);
    assertEquals(byId, [member.email]);
  });
});
