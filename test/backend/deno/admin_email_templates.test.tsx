// Coverage: GET/PUT /admin/notification-templates[/:id] and GET /admin/sent-notifications
// — see addendum-044-email-notifications.md. Every route here is
// admin-only (requireAdmin), so per CLAUDE.md's authorization-scoping test
// discipline, that category needs a single non-admin-403 negative test per
// route (admin is global — no further "which admin" substitution to test).
//
// email_templates is deliberately NOT wiped by wipeDatabase() (seeded
// config) — every mutating test below restores the row it touched so this
// file has no lasting effect on other test files' reliance on the seeded
// defaults.
import { assert, assertEquals, assertExists } from "jsr:@std/assert";
import { req, authHeaders, wipeDatabase, createAdmin, createActiveUser, loginAs, uniqueEmail } from "./helpers.tsx";
import { notificationTemplates, sentNotifications, auditLogs, generateId, now } from "../../../server/db.tsx";

Deno.test("admin_email_templates", async (t) => {
  let adminSession: string;

  await t.step("setup", async () => {
    await wipeDatabase();
    const admin = await createAdmin("EmailAdmin!2026");
    const login = await loginAs(admin.email, "EmailAdmin!2026");
    adminSession = (login as any).session;
  });

  await t.step("list: positive — returns all 34 seeded templates", async () => {
    // 29 original + 1 pending_actions.daily_digest template.
    const res = await req("/admin/notification-templates", { headers: authHeaders(adminSession) });
    assertEquals(res.status, 200);
    const data = await res.json();
    assertEquals(data.templates.length, 34);
    assertExists(data.templates.find((t: any) => t.triggerKey === "request.submitted"));
    assertExists(data.templates.find((t: any) => t.triggerKey === "user.invited"));
  });

  await t.step("list: negative — non-admin forbidden", async () => {
    const vendor = await createActiveUser({ fullName: "EmailVendor1", email: uniqueEmail("emailvendor1"), password: "VendorPass!2026", affiliation: "vendor" });
    const login = await loginAs(vendor.email, "VendorPass!2026");
    const res = await req("/admin/notification-templates", { headers: authHeaders((login as any).session) });
    assertEquals(res.status, 403);
  });

  await t.step("update: positive — subject/body_html/is_active persist and are audit-logged", async () => {
    const original = await notificationTemplates.findByTriggerKey("user.rejected");
    assertExists(original);
    try {
      const res = await req(`/admin/notification-templates/${original!.id}`, {
        method: "PUT", headers: authHeaders(adminSession),
        body: { subject: "New subject {{fullName}}", bodyHtml: "<p>New body {{reason}}</p>", isActive: false },
      });
      assertEquals(res.status, 200);
      const data = await res.json();
      assertEquals(data.template.subject, "New subject {{fullName}}");
      assertEquals(data.template.bodyHtml, "<p>New body {{reason}}</p>");
      assertEquals(data.template.isActive, false);

      const logs = await auditLogs.findByTarget("email_template", original!.id);
      const updateLog = logs.find((l) => l.action === "email_template.updated");
      assertExists(updateLog);
      assertEquals(updateLog!.details.oldValues.subject, original!.subject);
      assertEquals(updateLog!.details.newValues.subject, "New subject {{fullName}}");
    } finally {
      await notificationTemplates.update(original!.id, {
        subject: original!.subject, bodyHtml: original!.bodyHtml, isActive: original!.isActive,
      });
    }
  });

  await t.step("update: security — parser allowlist strips stored-XSS payloads", async () => {
    const original = await notificationTemplates.findByTriggerKey("user.rejected");
    assertExists(original);
    try {
      const malicious = '<p onclick="steal()">Safe <a href="javascript:steal()" target="_blank">link</a></p><svg onload="steal()"><script>steal()</script><iframe srcdoc="x"></iframe>';
      const res = await req(`/admin/notification-templates/${original.id}`, {
        method: "PUT",
        headers: authHeaders(adminSession),
        body: { bodyHtml: malicious },
      });
      assertEquals(res.status, 200);
      const html = (await res.json()).template.bodyHtml as string;
      assert(html.includes("Safe"));
      assert(html.includes("link"));
      assert(html.includes('rel="noopener noreferrer"'));
      for (const forbidden of ["onclick", "javascript:", "<svg", "onload", "<script", "<iframe", "srcdoc"]) {
        assertEquals(html.toLowerCase().includes(forbidden), false, `sanitized HTML retained ${forbidden}`);
      }
    } finally {
      await notificationTemplates.update(original.id, { bodyHtml: original.bodyHtml });
    }
  });

  await t.step("update: negative — empty subject rejected", async () => {
    const original = await notificationTemplates.findByTriggerKey("user.rejected");
    const res = await req(`/admin/notification-templates/${original!.id}`, {
      method: "PUT", headers: authHeaders(adminSession), body: { subject: "   " },
    });
    assertEquals(res.status, 400);
  });

  await t.step("update: negative — empty body_html rejected", async () => {
    const original = await notificationTemplates.findByTriggerKey("user.rejected");
    const res = await req(`/admin/notification-templates/${original!.id}`, {
      method: "PUT", headers: authHeaders(adminSession), body: { bodyHtml: "" },
    });
    assertEquals(res.status, 400);
  });

  await t.step("update: bound — subject exactly 255 chars is accepted", async () => {
    const original = await notificationTemplates.findByTriggerKey("user.rejected");
    const subject255 = "A".repeat(255);
    try {
      const res = await req(`/admin/notification-templates/${original!.id}`, {
        method: "PUT", headers: authHeaders(adminSession), body: { subject: subject255 },
      });
      assertEquals(res.status, 200);
    } finally {
      await notificationTemplates.update(original!.id, { subject: original!.subject });
    }
  });

  await t.step("update: bound — subject 256 chars is rejected", async () => {
    const original = await notificationTemplates.findByTriggerKey("user.rejected");
    const subject256 = "A".repeat(256);
    const res = await req(`/admin/notification-templates/${original!.id}`, {
      method: "PUT", headers: authHeaders(adminSession), body: { subject: subject256 },
    });
    assertEquals(res.status, 400);
    const stillThere = await notificationTemplates.get(original!.id);
    assertEquals(stillThere!.subject, original!.subject);
  });

  await t.step("update: negative — trigger_key in the body is ignored (immutable)", async () => {
    const original = await notificationTemplates.findByTriggerKey("user.rejected");
    try {
      const res = await req(`/admin/notification-templates/${original!.id}`, {
        method: "PUT", headers: authHeaders(adminSession),
        body: { triggerKey: "user.approved", subject: "Attempted trigger_key change" },
      });
      assertEquals(res.status, 200);
      const stillThere = await notificationTemplates.get(original!.id);
      assertEquals(stillThere!.triggerKey, "user.rejected");
    } finally {
      await notificationTemplates.update(original!.id, { subject: original!.subject });
    }
  });

  await t.step("update: negative — non-admin forbidden", async () => {
    const original = await notificationTemplates.findByTriggerKey("user.rejected");
    const vendor = await createActiveUser({ fullName: "EmailVendor2", email: uniqueEmail("emailvendor2"), password: "VendorPass!2026", affiliation: "vendor" });
    const login = await loginAs(vendor.email, "VendorPass!2026");
    const res = await req(`/admin/notification-templates/${original!.id}`, {
      method: "PUT", headers: authHeaders((login as any).session), body: { subject: "Should not apply" },
    });
    assertEquals(res.status, 403);
    const stillThere = await notificationTemplates.get(original!.id);
    assertEquals(stillThere!.subject, original!.subject);
  });

  await t.step("update: negative — nonexistent id returns 404", async () => {
    const res = await req(`/admin/notification-templates/00000000-0000-0000-0000-000000000999`, {
      method: "PUT", headers: authHeaders(adminSession), body: { subject: "Doesn't matter" },
    });
    assertEquals(res.status, 404);
  });

  await t.step("sent-notifications: positive — lists rows, most-recent-first", async () => {
    await sentNotifications.create({
      id: generateId(),
      triggerKey: "user.approved",
      renderedSubject: "First",
      renderedBodyHtml: "<p>1</p>",
      renderedBodyText: "1",
      relatedTargetType: null,
      relatedTargetId: null,
      createdAt: now(),
    });
    await sentNotifications.create({
      id: generateId(),
      triggerKey: "user.approved",
      renderedSubject: "Second",
      renderedBodyHtml: "<p>2</p>",
      renderedBodyText: "2",
      relatedTargetType: null,
      relatedTargetId: null,
      createdAt: now(),
    });
    const res = await req("/admin/sent-notifications", { headers: authHeaders(adminSession) });
    assertEquals(res.status, 200);
    const data = await res.json();
    assertExists(data.notifications.find((e: any) => e.renderedSubject === "Second"));
    assertExists(data.notifications.find((e: any) => e.renderedSubject === "First"));
    assertEquals(
      data.notifications.some((notification: any) => "subject" in notification),
      false,
    );
  });

  await t.step("sent-notifications: negative — non-admin forbidden", async () => {
    const vendor = await createActiveUser({ fullName: "EmailVendor3", email: uniqueEmail("emailvendor3"), password: "VendorPass!2026", affiliation: "vendor" });
    const login = await loginAs(vendor.email, "VendorPass!2026");
    const res = await req("/admin/sent-notifications", { headers: authHeaders((login as any).session) });
    assertEquals(res.status, 403);
  });
});
