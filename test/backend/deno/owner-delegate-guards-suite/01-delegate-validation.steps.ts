// POST/DELETE /owner/systems/:id/delegates[/:delegateId] — the validation arms
// behind §E's "My Systems & Delegates" element stories that owner.test.tsx
// does NOT already pin. owner.test.tsx owns: the positive 201 (+ notification
// wiring), delegate-to-self 400, the non-primary-owner 404 disguise, the
// vendor-affiliation 400 (with no-row-created proof), the cross-org and
// unanchored eligibility 400s; time_bound_delegations.test.tsx owns the window
// persistence, the from>=until schema 400 and the expired-window denial.
// This file pins what remains: the unknown-system 404, the inactive-target
// 400, the already-an-owner 400, the duplicate 400, and the delete 404.
import { assertEquals } from "jsr:@std/assert";
import {
  req, authHeaders, createOrganization, addOrgMembership, uniqueShortCode, uniqueName,
  repointOwnerOrgEdge,
} from "../helpers.tsx";
import type { SuiteContext } from "./00-context.ts";

export async function run01Steps(t: Deno.TestContext, context: SuiteContext): Promise<void> {
  const {
    adminId, ownerSession, systemId, delegateCandidateId, backupOwnerId,
  } = context;

  await t.step("delegates: negative — adding to an unknown system 404s", async () => {
    const res = await req(`/owner/systems/${crypto.randomUUID()}/delegates`, {
      method: "POST", headers: authHeaders(ownerSession), body: { delegateUserId: delegateCandidateId },
    });
    assertEquals(res.status, 404);
    const body = await res.json();
    assertEquals(body.error, "System not found.");
  });

  await t.step("delegates: negative — an unknown (or inactive) delegate user id rejected 400", async () => {
    const res = await req(`/owner/systems/${systemId}/delegates`, {
      method: "POST", headers: authHeaders(ownerSession), body: { delegateUserId: crypto.randomUUID() },
    });
    assertEquals(res.status, 400);
    const body = await res.json();
    assertEquals(body.error, "Delegate must be an active user.");
  });

  await t.step("delegates: negative — an existing OWNER of the system cannot also be its delegate", async () => {
    const res = await req(`/owner/systems/${systemId}/delegates`, {
      method: "POST", headers: authHeaders(ownerSession), body: { delegateUserId: backupOwnerId },
    });
    assertEquals(res.status, 400);
    const body = await res.json();
    assertEquals(body.error, "This user is already an owner of the system.");
  });

  await t.step("delegates: negative — the second add of the same delegate rejected 400 (after a real 201)", async () => {
    // Re-point the system's owner edge to a fresh org and enlist the
    // candidate so the FIRST add really lands — the duplicate arm is only
    // meaningful against a live row (mirrors owner.test.tsx's anchorSystemOrg:
    // addendum-206 §4.3 — the junction, not the cluster, is the org truth).
    const org = await createOrganization({
      name: uniqueName("DG Org"), shortCode: uniqueShortCode(), createdBy: adminId,
    });
    await repointOwnerOrgEdge(systemId, org.id, adminId);
    await addOrgMembership({ organizationId: org.id, userId: delegateCandidateId, addedBy: adminId });

    const first = await req(`/owner/systems/${systemId}/delegates`, {
      method: "POST", headers: authHeaders(ownerSession), body: { delegateUserId: delegateCandidateId },
    });
    assertEquals(first.status, 201);

    const res = await req(`/owner/systems/${systemId}/delegates`, {
      method: "POST", headers: authHeaders(ownerSession), body: { delegateUserId: delegateCandidateId },
    });
    assertEquals(res.status, 400);
    const body = await res.json();
    assertEquals(body.error, "This user is already a delegate for this system.");
  });

  await t.step("delegates: negative — deleting an unknown delegate id 404s", async () => {
    const res = await req(`/owner/systems/${systemId}/delegates/${crypto.randomUUID()}`, {
      method: "DELETE", headers: authHeaders(ownerSession),
    });
    assertEquals(res.status, 404);
    const body = await res.json();
    assertEquals(body.error, "Delegate not found for this system.");
  });
}
