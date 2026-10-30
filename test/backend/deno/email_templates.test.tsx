// Coverage: server/email-templates.tsx's interpolate() (pure) and
// renderEmailTemplate() (DB-lookup + interpolate). See
// addendum-044-email-notifications.md.
//
// email_templates is deliberately NOT wiped by wipeDatabase() (seeded
// config, like schema_migrations — see helpers.tsx's CLEAR_TABLES comment),
// which means mutations here are visible to every OTHER test file that
// runs afterward in the same `deno task test` invocation (Deno runs test
// files sequentially). Every test below that mutates a shared template row
// restores its original subject/body_html/is_active before returning, so
// this file has zero lasting effect on the seeded defaults other test
// files (e.g. admin_users.test.tsx's user.approved coverage) rely on.
import { assertEquals, assertExists } from "jsr:@std/assert";
import { wipeDatabase, reactivateEmailTemplates } from "./helpers.tsx";
import { query } from "../../../server/pg.tsx";
import { interpolate, renderEmailTemplate, htmlToPlainText, sanitizeEmailHtml } from "../../../server/email/templates.tsx";
import { notificationTemplates, generateId, now } from "../../../server/db.tsx";
import type { NotificationTemplate } from "../../../server/types.tsx";

Deno.test("htmlToPlainText (Slack DM rendering)", async (t) => {
  await t.step("setup", async () => {
    await wipeDatabase();
  });

  await t.step("strips tags and preserves paragraph breaks", () => {
    const html = "<p>Your request <strong>BG-001</strong> for System (SR 42) is ready.</p><p>Please review.</p>";
    const text = htmlToPlainText(html);
    assertEquals(text, "Your request BG-001 for System (SR 42) is ready.\n\nPlease review.");
  });

  await t.step("keeps direct links usable as 'label (url)'", () => {
    const html = '<p>Open it: <a href="https://app.example.com/?dl=AbC123">Open request</a></p>';
    const text = htmlToPlainText(html);
    assertEquals(text, "Open it: Open request (https://app.example.com/?dl=AbC123)");
  });

  await t.step("decodes common HTML entities", () => {
    const html = "<p>A &amp; B &lt; C &gt; D &quot;E&quot; &nbsp;F</p>";
    assertEquals(htmlToPlainText(html), 'A & B < C > D "E" F');
  });

  await t.step("empty / whitespace-only html collapses to empty string", () => {
    assertEquals(htmlToPlainText(""), "");
    assertEquals(htmlToPlainText("<p>   </p>"), "");
  });
});

Deno.test("sanitizeEmailHtml (stored-XSS defense, addendum-075)", async (t) => {
  await t.step("setup", async () => {
    await wipeDatabase();
  });

  await t.step("strips script/style/iframe blocks", () => {
    const dirty = "<p>Hello</p><script>alert(1)</script><style>body{display:none}</style><iframe src='https://evil.test'></iframe>";
    const clean = sanitizeEmailHtml(dirty);
    assertEquals(clean.includes("<script"), false);
    assertEquals(clean.includes("<style"), false);
    assertEquals(clean.includes("<iframe"), false);
    assertEquals(clean.includes("<p>Hello</p>"), true);
  });

  await t.step("strips event-handler attributes and javascript: URLs", () => {
    const dirty = '<a href="javascript:alert(1)" onclick="steal()">link</a><img src="x" onerror="alert(1)">';
    const clean = sanitizeEmailHtml(dirty);
    assertEquals(clean.includes("javascript:"), false);
    assertEquals(clean.includes("onclick"), false);
    assertEquals(clean.includes("onerror"), false);
  });

  await t.step("preserves benign markup", () => {
    const html = "<p><strong>Bold</strong> and <a href=\"https://example.com/?dl=AbC\">link</a></p>";
    assertEquals(sanitizeEmailHtml(html), html);
  });
});

Deno.test("email_templates render engine", async (t) => {
  await t.step("setup", async () => {
    await wipeDatabase();
    // email_templates survives wipeDatabase (seeded config). An earlier file in
    // the same `deno test dir/` run (audit_all_entities toggles a seeded
    // template's is_active) may have left a template inactive; renderEmailTemplate
    // needs the active row, so reactivate here to be order-independent.
    await reactivateEmailTemplates();
  });

  await t.step("interpolate: positive — substitutes every matching placeholder", () => {
    const result = interpolate("Hello {{name}}, request {{request_number}} is ready.", {
      name: "Alice",
      request_number: "BG-001",
    });
    assertEquals(result, "Hello Alice, request BG-001 is ready.");
  });

  await t.step("interpolate: positive — an unmatched placeholder renders empty (Handlebars semantics)", () => {
    // Behavior change from the former hand-rolled engine (addendum-050): an
    // unmatched {{placeholder}} now renders as empty, not left literal.
    const result = interpolate("Hello {{name}}, {{typo_field}} is gone.", { name: "Bob" });
    assertEquals(result, "Hello Bob,  is gone.");
  });

  await t.step("interpolate: positive — {{var}} HTML-escapes its value", () => {
    // Handlebars default escaping — a value containing HTML is escaped so it
    // renders as text, not markup.
    const result = interpolate("Name: {{name}}", { name: '<b>x</b>&"y"' });
    assertEquals(result, "Name: &lt;b&gt;x&lt;/b&gt;&amp;&quot;y&quot;");
  });

  await t.step("interpolate: positive — {{{var}}} emits the value raw (unescaped)", () => {
    const result = interpolate("Body: {{{html}}}", { html: "<i>ok</i>" });
    assertEquals(result, "Body: <i>ok</i>");
  });

  await t.step("interpolate: positive — a template with no placeholders passes through unchanged", () => {
    const result = interpolate("<p>Static content only.</p>", { unused: "value" });
    assertEquals(result, "<p>Static content only.</p>");
  });

  await t.step("interpolate: positive — empty template returns empty string", () => {
    assertEquals(interpolate("", { name: "Alice" }), "");
  });

  await t.step("renderEmailTemplate: positive — renders subject and body against an active template", async () => {
    const original = await notificationTemplates.findByTriggerKey("request.submitted");
    assertExists(original);
    await notificationTemplates.update(original!.id, {
      subject: "Hi {{name}}", bodyHtml: "<p>{{name}} submitted {{request_number}}</p>",
    });
    try {
      const rendered = await renderEmailTemplate("request.submitted", { name: "Carol", request_number: "BG-002" });
      assertExists(rendered);
      assertEquals(rendered!.subject, "Hi Carol");
      assertEquals(rendered!.html, "<p>Carol submitted BG-002</p>");
    } finally {
      await notificationTemplates.update(original!.id, { subject: original!.subject, bodyHtml: original!.bodyHtml });
    }
  });

  await t.step("renderEmailTemplate: negative — returns null when the template is inactive", async () => {
    const original = await notificationTemplates.findByTriggerKey("user.approved");
    assertExists(original);
    await notificationTemplates.update(original!.id, { isActive: false });
    try {
      const rendered = await renderEmailTemplate("user.approved", { full_name: "Dave" });
      assertEquals(rendered, null);
    } finally {
      await notificationTemplates.update(original!.id, { isActive: true });
    }
  });

  await t.step("renderEmailTemplate: negative — returns null when no row exists for the key", async () => {
    // notificationTemplates deliberately exposes no delete/invalidate (no
    // create/remove-a-template concept) — exercising the not-found path
    // requires reaching past db.tsx's normal accessor surface directly,
    // acceptable here since it's testing renderEmailTemplate's own
    // null-handling for a missing row, restored immediately after.
    const original: NotificationTemplate = (await notificationTemplates.findByTriggerKey("asset_inventory.sync_failed"))!;
    assertExists(original);
    await query(`DELETE FROM notification_templates WHERE id = $1`, [original.id]);
    try {
      const rendered = await renderEmailTemplate("asset_inventory.sync_failed", { system_name: "SYS1", error_message: "boom" });
      assertEquals(rendered, null);
    } finally {
      await notificationTemplates.create({
        id: generateId(), triggerKey: original.triggerKey, subject: original.subject, bodyHtml: original.bodyHtml,
        variables: original.variables, isActive: original.isActive, createdBy: original.createdBy,
        createdAt: now(), updatedAt: now(),
      });
    }
  });
});
