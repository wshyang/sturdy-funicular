// POST /requests/:id/asset-custody/exceptions — the multipart report
// VALIDATION arms behind §F's problem-report modal that
// physical_asset_custody.test.tsx does not already pin (it owns the positive
// two-attachment exception, the spoofed/executable/empty/oversized upload
// arms, and the action-route bounds arms). Remaining gaps covered here: the
// unknown-request 404, the report-validity 400s (bogus type, empty or
// over-long description, non-UUID case id) and the 20-file attachment cap.
// All fire BEFORE any custody-case resolution, so a plain submitted request
// suffices.
import { assertEquals } from "jsr:@std/assert";
import { reqFormData } from "../helpers.tsx";
import type { SuiteContext } from "./00-context.ts";

function baseForm(): FormData {
  const form = new FormData();
  form.append("custodyCaseId", crypto.randomUUID());
  form.append("exceptionType", "missing");
  form.append("description", "Checked Cabinet C2 thoroughly, item absent.");
  form.append("checkedExpectedLocation", "true");
  form.append("checkedRegister", "true");
  return form;
}

export async function run01Steps(t: Deno.TestContext, context: SuiteContext): Promise<void> {
  const { submitterSession, requestId } = context;

  await t.step("exceptions: negative — an unknown request id 404s before any body validation", async () => {
    const res = await reqFormData(`/requests/${crypto.randomUUID()}/asset-custody/exceptions`, submitterSession, baseForm());
    assertEquals(res.status, 404);
    const body = await res.json();
    assertEquals(body.error, "Request not found.");
  });

  await t.step("exceptions: negative — a bogus exceptionType rejected 400", async () => {
    const form = baseForm();
    form.set("exceptionType", "exploded");
    const res = await reqFormData(`/requests/${requestId}/asset-custody/exceptions`, submitterSession, form);
    assertEquals(res.status, 400);
    const body = await res.json();
    assertEquals(body.error, "Invalid custody exception report.");
  });

  await t.step("exceptions: negative — an empty description rejected 400 (the route twin of the modal's review gate)", async () => {
    const form = baseForm();
    form.delete("description");
    const res = await reqFormData(`/requests/${requestId}/asset-custody/exceptions`, submitterSession, form);
    assertEquals(res.status, 400);
    const body = await res.json();
    assertEquals(body.error, "Invalid custody exception report.");
  });

  await t.step("exceptions: negative — an over-long (>4000 char) description rejected 400", async () => {
    const form = baseForm();
    form.set("description", "x".repeat(4001));
    const res = await reqFormData(`/requests/${requestId}/asset-custody/exceptions`, submitterSession, form);
    assertEquals(res.status, 400);
    const body = await res.json();
    assertEquals(body.error, "Invalid custody exception report.");
  });

  await t.step("exceptions: negative — a non-UUID custodyCaseId rejected 400", async () => {
    const form = baseForm();
    form.set("custodyCaseId", "not-a-uuid");
    const res = await reqFormData(`/requests/${requestId}/asset-custody/exceptions`, submitterSession, form);
    assertEquals(res.status, 400);
    const body = await res.json();
    assertEquals(body.error, "Invalid custody exception report.");
  });

  await t.step("exceptions: negative — 21 attachments exceed the 20-file cap (400)", async () => {
    const form = baseForm();
    for (let i = 0; i < 21; i++) {
      form.append("attachments", new File([`note ${i}`], `note-${i}.txt`, { type: "text/plain" }));
    }
    const res = await reqFormData(`/requests/${requestId}/asset-custody/exceptions`, submitterSession, form);
    assertEquals(res.status, 400);
    const body = await res.json();
    assertEquals(body.error, "Attachments must be files (maximum 20).");
  });
}
