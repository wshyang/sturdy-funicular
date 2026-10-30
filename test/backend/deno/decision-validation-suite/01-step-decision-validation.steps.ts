// POST /requests/:id/step-decision — the route-boundary validation and
// authorization arms the frontend negative stories (§C/§D reviewer modal:
// Return/Reject need notes; only the current step's reviewer sees the action)
// lean on, previously unexercised at this tier: requests.test.tsx drives the
// happy paths and state-guards.test.tsx the status guards, but the 400/403
// classes in between had no pin.
import { assertEquals } from "jsr:@std/assert";
import { req, authHeaders } from "../helpers.tsx";
import type { SuiteContext } from "./00-context.ts";

export async function run01Steps(t: Deno.TestContext, context: SuiteContext): Promise<void> {
  const {
    requestId, vendorApproverSession, agencyApproverSession, strangerSession,
  } = context;

  await t.step("step-decision: negative — invalid decision value rejected 400 before authz is even consulted", async () => {
    // Deliberately sent as the STRANGER: validation precedes authorization, so
    // a bad enum yields 400 (not 403) for anyone.
    const res = await req(`/requests/${requestId}/step-decision`, {
      method: "POST",
      headers: authHeaders(strangerSession),
      body: { decision: "approve-ish" },
    });
    assertEquals(res.status, 400);
    const body = await res.json();
    assertEquals(body.error, "decision must be 'approve', 'return', or 'reject'.");
  });

  await t.step("step-decision: negative — return without notes rejected 400, request untouched", async () => {
    const res = await req(`/requests/${requestId}/step-decision`, {
      method: "POST",
      headers: authHeaders(vendorApproverSession),
      body: { decision: "return" },
    });
    assertEquals(res.status, 400);
    const body = await res.json();
    assertEquals(body.error, "Notes are required when returning or rejecting a request.");
  });

  await t.step("step-decision: negative — reject without notes rejected 400", async () => {
    const res = await req(`/requests/${requestId}/step-decision`, {
      method: "POST",
      headers: authHeaders(vendorApproverSession),
      body: { decision: "reject" },
    });
    assertEquals(res.status, 400);
    const body = await res.json();
    assertEquals(body.error, "Notes are required when returning or rejecting a request.");
  });

  await t.step("step-decision: negative — unknown request id 404s for the assigned reviewer", async () => {
    const res = await req(`/requests/${crypto.randomUUID()}/step-decision`, {
      method: "POST",
      headers: authHeaders(vendorApproverSession),
      body: { decision: "approve" },
    });
    assertEquals(res.status, 404);
    const body = await res.json();
    assertEquals(body.error, "Request not found.");
  });

  await t.step("step-decision: negative — downstream reviewer without the override flag gets 403", async () => {
    // agencyApprover owns step 3, but the request sits at step 2: assigned-to-
    // a-step is not assigned-to-THIS-step.
    const res = await req(`/requests/${requestId}/step-decision`, {
      method: "POST",
      headers: authHeaders(agencyApproverSession),
      body: { decision: "approve" },
    });
    assertEquals(res.status, 403);
    const body = await res.json();
    assertEquals(body.error, "You are not authorized to act on the current approval step.");
  });

  await t.step("step-decision: negative — override requested by someone on NO step is refused 403", async () => {
    const res = await req(`/requests/${requestId}/step-decision`, {
      method: "POST",
      headers: authHeaders(strangerSession),
      body: { decision: "approve", notes: "Trying the emergency lane.", override: true },
    });
    assertEquals(res.status, 403);
    const body = await res.json();
    assertEquals(body.error, "You are not authorized to override this step.");
  });

  await t.step("step-decision: positive — a downstream reviewer MAY override the current step when they ask for it", async () => {
    const res = await req(`/requests/${requestId}/step-decision`, {
      method: "POST",
      headers: authHeaders(agencyApproverSession),
      body: { decision: "approve", notes: "Emergency override: vendor L2 unreachable.", override: true },
    });
    assertEquals(res.status, 200);
  });

  await t.step("step-decision: positive — the override advanced the chain, so the same reviewer now owns the current step WITHOUT the flag", async () => {
    const res = await req(`/requests/${requestId}/step-decision`, {
      method: "POST",
      headers: authHeaders(agencyApproverSession),
      body: { decision: "approve" },
    });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.message, "Step approved; routed to system owner.");
  });
}
