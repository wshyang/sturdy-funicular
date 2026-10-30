// Red-regiment ledger row 8 — time-bound delegations (assessment
// docs/assessments/2026-08-04-time-bound-delegations.md).
//
// Implementation is complete (addendum-110+, addendum-113):
//   1. POST /owner/systems/:id/delegates accepts activeFrom/activeUntil,
//      persists them, and the enriched delegates list exposes them.
//   2. activeFrom >= activeUntil is a 400 validation error (the repo
//      convention: 400, not 409, for validation).
//   3. A delegate whose window has expired can no longer approve
//      (canApprove === false — the mid-flight 403 class).
//
// addendum-134, as amended by 206 §4.3: delegate eligibility is agency-only
// with live org membership in a LINKED org — the junction owner edge is the
// org truth. provisionOwnerSystem re-points the system's owner edge to a
// fresh org and adds the delegate as a member (mirrors the anchorSystemOrg
// helper in owner.test.tsx).
//
// Route/fixture style mirrors owner.test.tsx (real DB, no mocks).
import { assertEquals } from "jsr:@std/assert";
import {
  req, authHeaders, wipeDatabase, createAdmin, createActiveUser, loginAs, uniqueEmail,
  createWiredSystem, createOrganization, addOrgMembership, uniqueShortCode, repointOwnerOrgEdge,
} from "./helpers.tsx";
import { canApprove } from "../../../server/auth.tsx";
import type { System } from "../../../server/types.tsx";

async function anchorSystemOrg(system: System, memberIds: string[], addedBy: string): Promise<void> {
  const org = await createOrganization({ name: `TBDOrg-${system.id.replace(/-/g, '')}`, shortCode: uniqueShortCode(), createdBy: addedBy });
  await repointOwnerOrgEdge(system.id, org.id, addedBy);
  for (const userId of memberIds) {
    await addOrgMembership({ organizationId: org.id, userId, addedBy });
  }
}

Deno.test("time-bound delegations", async (t) => {
  let adminId: string;

  await t.step("setup", async () => {
    await wipeDatabase();
    const admin = await createAdmin("TimeDelAdmin!2026");
    adminId = admin.id;
  });

  async function provisionOwnerSystem() {
    const owner = await createActiveUser({
      fullName: "TBD Owner", email: uniqueEmail("tbd-owner"), password: "TbdOwner!2026", affiliation: "agency",
    });
    const { system } = await createWiredSystem(adminId, owner);
    const ownerSession = (await loginAs(owner.email, "TbdOwner!2026") as { session: string }).session;
    const delegate = await createActiveUser({
      fullName: "TBD Delegate", email: uniqueEmail("tbd-delegate"), password: "TbdDelegate!2026", affiliation: "agency",
    });
    await anchorSystemOrg(system, [delegate.id], adminId);
    return { system, ownerSession, delegate };
  }

  await t.step("add with window: activeFrom/activeUntil persist and surface on the enriched delegates list", async () => {
    const { system, ownerSession, delegate } = await provisionOwnerSystem();
    const activeFrom = "2026-08-06T00:00:00.000Z";
    const activeUntil = "2026-08-12T00:00:00.000Z";
    const res = await req(`/owner/systems/${system.id}/delegates`, {
      method: "POST", headers: authHeaders(ownerSession),
      body: { delegateUserId: delegate.id, activeFrom, activeUntil },
    });
    // RED today: the payload fields are silently dropped — the delegate row
    // exists but carries no window (and the response exposes none).
    assertEquals(res.status, 201);
    const data = await res.json();
    assertEquals(data.delegate.activeFrom, activeFrom);
    assertEquals(data.delegate.activeUntil, activeUntil);

    const list = await req("/owner/systems", { headers: authHeaders(ownerSession) });
    assertEquals(list.status, 200);
    const row = (await list.json()).systems.find((s: { id: string }) => s.id === system.id);
    const enriched = row.delegates.find((d: { delegateUserId: string }) => d.delegateUserId === delegate.id);
    assertEquals(enriched.activeFrom, activeFrom);
    assertEquals(enriched.activeUntil, activeUntil);
  });

  await t.step("negative: activeFrom >= activeUntil is a 400 validation error", async () => {
    const { system, ownerSession, delegate } = await provisionOwnerSystem();
    const res = await req(`/owner/systems/${system.id}/delegates`, {
      method: "POST", headers: authHeaders(ownerSession),
      body: {
        delegateUserId: delegate.id,
        activeFrom: "2026-08-12T00:00:00.000Z",
        activeUntil: "2026-08-06T00:00:00.000Z",
      },
    });
    // RED today: the window is ignored entirely and the delegate is created
    // (201).
    assertEquals(res.status, 400);
  });

  await t.step("expired window: canApprove is false once activeUntil has passed (mid-flight 403 class)", async () => {
    const { system, ownerSession, delegate } = await provisionOwnerSystem();
    const twoDaysAgo = new Date(Date.now() - 48 * 3600_000).toISOString();
    const oneDayAgo = new Date(Date.now() - 24 * 3600_000).toISOString();
    const res = await req(`/owner/systems/${system.id}/delegates`, {
      method: "POST", headers: authHeaders(ownerSession),
      body: { delegateUserId: delegate.id, activeFrom: twoDaysAgo, activeUntil: oneDayAgo },
    });
    assertEquals(res.status, 201);

    // RED today: canApprove only checks owner ∪ delegate row presence — the
    // expired window changes nothing, so this returns true.
    assertEquals(await canApprove(delegate.id, system.id), false);
  });
});
