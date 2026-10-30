// POST /requests/:id/owner-decision — the terminal-decision validation and
// authorization arms mirroring §E's owner modal negatives (reject needs
// notes) and the delegate flow's backend half: prior suites drove owner
// decisions only as positive lifecycle plumbing (concurrency, aws-*), never
// pinning these failure classes.
import { assertEquals } from "jsr:@std/assert";
import {
  req, authHeaders, createOrganization, addOrgMembership, uniqueShortCode, uniqueName,
  repointOwnerOrgEdge,
} from "../helpers.tsx";
import type { SuiteContext } from "./00-context.ts";

export async function run02Steps(t: Deno.TestContext, context: SuiteContext): Promise<void> {
  const {
    adminId, systemId, requestId, ownerSession, strangerSession,
    delegateUserId, delegateSession,
  } = context;

  await t.step("owner-decision: negative — invalid decision value rejected 400", async () => {
    const res = await req(`/requests/${requestId}/owner-decision`, {
      method: "POST",
      headers: authHeaders(ownerSession),
      body: { decision: "approve-ish" },
    });
    assertEquals(res.status, 400);
    const body = await res.json();
    assertEquals(body.error, "decision must be 'approve', 'return', or 'reject'.");
  });

  await t.step("owner-decision: negative — return without notes rejected 400", async () => {
    const res = await req(`/requests/${requestId}/owner-decision`, {
      method: "POST",
      headers: authHeaders(ownerSession),
      body: { decision: "return" },
    });
    assertEquals(res.status, 400);
    const body = await res.json();
    assertEquals(body.error, "Notes are required when returning or rejecting a request.");
  });

  await t.step("owner-decision: negative — reject without notes rejected 400", async () => {
    const res = await req(`/requests/${requestId}/owner-decision`, {
      method: "POST",
      headers: authHeaders(ownerSession),
      body: { decision: "reject" },
    });
    assertEquals(res.status, 400);
    const body = await res.json();
    assertEquals(body.error, "Notes are required when returning or rejecting a request.");
  });

  await t.step("owner-decision: negative — a stranger to the system cannot take the terminal decision", async () => {
    const res = await req(`/requests/${requestId}/owner-decision`, {
      method: "POST",
      headers: authHeaders(strangerSession),
      body: { decision: "approve" },
    });
    assertEquals(res.status, 403);
    const body = await res.json();
    assertEquals(body.error, "You are not authorized to make the owner decision for this system.");
  });

  await t.step("owner-decision: negative — unknown request id 404s for the owner", async () => {
    const res = await req(`/requests/${crypto.randomUUID()}/owner-decision`, {
      method: "POST",
      headers: authHeaders(ownerSession),
      body: { decision: "approve" },
    });
    assertEquals(res.status, 404);
    const body = await res.json();
    assertEquals(body.error, "Request not found.");
  });

  await t.step("owner-decision: positive — an in-window delegate can take the terminal decision; a repeat hits the guard", async () => {
    // Delegates must be agency users sharing one of the system's LINKED
    // organisations (addendum-206 §4.3, amending 134): re-point the owner
    // edge to a fresh org and enlist the delegate, mirroring
    // owner.test.tsx's anchorSystemOrg.
    const org = await createOrganization({
      name: uniqueName("DV Org"), shortCode: uniqueShortCode(), createdBy: adminId,
    });
    await repointOwnerOrgEdge(systemId, org.id, adminId);
    await addOrgMembership({ organizationId: org.id, userId: delegateUserId, addedBy: adminId });

    const addRes = await req(`/owner/systems/${systemId}/delegates`, {
      method: "POST",
      headers: authHeaders(ownerSession),
      body: { delegateUserId },
    });
    assertEquals(addRes.status, 201);

    const res = await req(`/requests/${requestId}/owner-decision`, {
      method: "POST",
      headers: authHeaders(delegateSession),
      body: { decision: "approve" },
    });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.message, "Request approved.");

    // The decision LANDED: the request is no longer awaiting a terminal call.
    const repeat = await req(`/requests/${requestId}/owner-decision`, {
      method: "POST",
      headers: authHeaders(ownerSession),
      body: { decision: "approve" },
    });
    assertEquals(repeat.status, 400);
    const repeatBody = await repeat.json();
    assertEquals(repeatBody.error, "This request is not awaiting the owner's terminal decision.");
  });
}
