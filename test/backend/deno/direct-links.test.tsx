// Direct-link resolution tests (plan_link_mapping.md / addendum-059).
//
// Focus, per the feature's security contract:
//   * A scoped key resolves ONLY for its intended recipient — a different,
//     authenticated, 2FA-verified user must NOT be able to resolve it.
//   * Every failure mode (wrong recipient, expired, unknown key, not visible)
//     returns the SAME generic message with no information disclosure.
//   * Resolution requires a fully 2FA-verified session.
//   * A valid key is still re-authorized against the live target (canViewRequest).
import { assertEquals, assertExists, assert } from "jsr:@std/assert";
import {
  req, authHeaders, wipeDatabase, createAdmin, createActiveUser, loginAs,
  uniqueEmail, createWiredSystem, createAsset, addMember, addServingMember,
} from "./helpers.tsx";
import { linkMappings, now } from "../../../server/db.tsx";
import { createLinkMapping, generateMappingKey } from "../../../server/direct-links.tsx";

const GENERIC = "This direct link is no longer valid.";

// A submittable request owned/reviewable by known users, plus the submitter
// session. Mirrors requests.test.tsx's setupScenario shape but inline here.
async function setupRequest(adminId: string) {
  const owner = await createActiveUser({
    fullName: "Owner", email: uniqueEmail("owner"), password: "OwnerPass!2026", affiliation: "agency",
  });
  const submitter = await createActiveUser({
    fullName: "Submitter", email: uniqueEmail("submitter"), password: "SubmitPass!2026", affiliation: "vendor",
  });
  const wired = await createWiredSystem(adminId, owner);
  // Put the submitter on the vendor L1 team so they can submit + view.
  await addServingMember(wired.vendorL1, submitter, adminId);

  const submitterLogin = await loginAs(submitter.email, "SubmitPass!2026") as { session: string; user: any };
  const asset = await createAsset(wired.system.id, { hostname: "host-01" });
  const submitRes = await req("/requests", {
    method: "POST",
    headers: authHeaders(submitterLogin.session),
    body: {
      systemId: wired.system.id,
      justification: "Investigate a production incident requiring elevated access.",
      srNumber: "SR-1001",
      activityStartAt: new Date(Date.now() + 3_600_000).toISOString(),
      activityEndAt: new Date(Date.now() + 4 * 3_600_000).toISOString(),
      credentialItems: [{ assetId: asset.id, hostnameDescription: "test host" }],
    },
  });
  const { request } = await submitRes.json();
  return { owner, submitter, submitterLogin, wired, request };
}

Deno.test("direct-links", async (t) => {
  let adminId = "";

  await t.step("setup", async () => {
    await wipeDatabase();
    const admin = await createAdmin("DLAdmin!2026");
    adminId = admin.id;
  });

  // ── helper / accessor layer ────────────────────────────────────────────

  await t.step("generateMappingKey: 12-char URL-safe, unique across calls", () => {
    const keys = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const k = generateMappingKey();
      assertEquals(k.length, 12);
      assert(/^[0-9A-Za-z]{12}$/.test(k), `key not base62: ${k}`);
      keys.add(k);
    }
    assertEquals(keys.size, 200); // no collisions
  });

  await t.step("consumeIfValidForUser: scoped key resolves for intended user, bumps usage", async () => {
    const u = await createActiveUser({ fullName: "U1", email: uniqueEmail("u1"), password: "Pass!2026aaa", affiliation: "vendor" });
    const key = await createLinkMapping("breakglass_request", crypto.randomUUID(), adminId, u.id);

    const first = await linkMappings.consumeIfValidForUser(key, u.id);
    assertExists(first);
    assertEquals(first!.usedCount, 1);
    assertExists(first!.usedAt);

    const second = await linkMappings.consumeIfValidForUser(key, u.id);
    assertEquals(second!.usedCount, 2); // increments each resolve
  });

  await t.step("consumeIfValidForUser: scoped key returns null for a DIFFERENT user", async () => {
    const intended = await createActiveUser({ fullName: "Intended", email: uniqueEmail("intended"), password: "Pass!2026aaa", affiliation: "vendor" });
    const other = await createActiveUser({ fullName: "Other", email: uniqueEmail("other"), password: "Pass!2026aaa", affiliation: "vendor" });
    const key = await createLinkMapping("breakglass_request", crypto.randomUUID(), adminId, intended.id);

    const wrong = await linkMappings.consumeIfValidForUser(key, other.id);
    assertEquals(wrong, null); // scoping enforced at the SQL layer

    // And the intended user still can (the failed attempt didn't consume/expire it).
    const right = await linkMappings.consumeIfValidForUser(key, intended.id);
    assertExists(right);
  });

  await t.step("consumeIfValidForUser: unscoped key (intended_user_id NULL) resolves for anyone", async () => {
    const anyone = await createActiveUser({ fullName: "Any", email: uniqueEmail("any"), password: "Pass!2026aaa", affiliation: "vendor" });
    const key = await createLinkMapping("breakglass_request", crypto.randomUUID(), adminId, null);
    const res = await linkMappings.consumeIfValidForUser(key, anyone.id);
    assertExists(res);
  });

  await t.step("consumeIfValidForUser: expired key returns null", async () => {
    const u = await createActiveUser({ fullName: "Exp", email: uniqueEmail("exp"), password: "Pass!2026aaa", affiliation: "vendor" });
    const key = generateMappingKey();
    // Insert directly with a past expires_at (createLinkMapping always uses the
    // configured TTL, so we bypass it to fabricate an already-expired row).
    await linkMappings.create({
      key, targetType: "breakglass_request", targetId: crypto.randomUUID(),
      createdBy: adminId, createdAt: now(), intendedUserId: u.id,
      expiresAt: new Date(Date.now() - 1000).toISOString(), usedAt: null, usedCount: 0,
    });
    const res = await linkMappings.consumeIfValidForUser(key, u.id);
    assertEquals(res, null);
  });

  // ── route layer: GET /link/resolve/:key ────────────────────────────────

  await t.step("resolve: 401 with no session token", async () => {
    const res = await req("/link/resolve/anykey123456");
    assertEquals(res.status, 401);
  });

  await t.step("resolve: 403 twofa_required for a 2FA-UNVERIFIED session", async () => {
    // enroll2fa:false → loginAs returns a session that never cleared 2FA.
    const u = await createActiveUser({
      fullName: "NoTwoFa", email: uniqueEmail("no2fa"), password: "Pass!2026aaa",
      affiliation: "vendor", enroll2fa: false,
    });
    const login = await loginAs(u.email, "Pass!2026aaa") as { session: string };
    const key = await createLinkMapping("breakglass_request", crypto.randomUUID(), adminId, u.id);
    const res = await req(`/link/resolve/${key}`, { headers: authHeaders(login.session) });
    assertEquals(res.status, 403);
    const body = await res.json();
    assertEquals(body.code, "twofa_required");
  });

  await t.step("resolve: intended recipient with a visible request → 200 target", async () => {
    const s = await setupRequest(adminId);
    const key = await createLinkMapping("breakglass_request", s.request.id, adminId, s.submitter.id);
    const res = await req(`/link/resolve/${key}`, { headers: authHeaders(s.submitterLogin.session) });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.targetType, "breakglass_request");
    assertEquals(body.targetId, s.request.id);
  });

  await t.step("resolve: NON-authorized user cannot resolve a link scoped to someone else → 404 generic", async () => {
    const s = await setupRequest(adminId);
    // Key scoped to the submitter…
    const key = await createLinkMapping("breakglass_request", s.request.id, adminId, s.submitter.id);
    // …attacked by an unrelated, fully-authenticated 2FA-verified outsider.
    const outsider = await createActiveUser({
      fullName: "Outsider", email: uniqueEmail("outsider"), password: "OutPass!2026", affiliation: "vendor",
    });
    const outsiderLogin = await loginAs(outsider.email, "OutPass!2026") as { session: string };
    const res = await req(`/link/resolve/${key}`, { headers: authHeaders(outsiderLogin.session) });
    assertEquals(res.status, 404);
    const body = await res.json();
    assertEquals(body.error, GENERIC); // no hint that the key exists or is "not for you"
  });

  await t.step("resolve: unscoped key but user cannot VIEW the request → 404 generic (canViewRequest re-check)", async () => {
    const s = await setupRequest(adminId);
    // Unscoped key (any 2FA user passes the scoping check)…
    const key = await createLinkMapping("breakglass_request", s.request.id, adminId, null);
    // …but the outsider has no visibility of the request, so canViewRequest fails.
    const outsider = await createActiveUser({
      fullName: "Outsider2", email: uniqueEmail("outsider2"), password: "OutPass!2026", affiliation: "vendor",
    });
    const outsiderLogin = await loginAs(outsider.email, "OutPass!2026") as { session: string };
    const res = await req(`/link/resolve/${key}`, { headers: authHeaders(outsiderLogin.session) });
    assertEquals(res.status, 404);
    assertEquals((await res.json()).error, GENERIC);
  });

  await t.step("resolve: unknown key → 404 generic (same message as every other failure)", async () => {
    const s = await setupRequest(adminId);
    const res = await req(`/link/resolve/doesnotexist99`, { headers: authHeaders(s.submitterLogin.session) });
    assertEquals(res.status, 404);
    assertEquals((await res.json()).error, GENERIC);
  });

  await t.step("resolve: expired key → 404 generic", async () => {
    const s = await setupRequest(adminId);
    const key = generateMappingKey();
    await linkMappings.create({
      key, targetType: "breakglass_request", targetId: s.request.id,
      createdBy: adminId, createdAt: now(), intendedUserId: s.submitter.id,
      expiresAt: new Date(Date.now() - 1000).toISOString(), usedAt: null, usedCount: 0,
    });
    const res = await req(`/link/resolve/${key}`, { headers: authHeaders(s.submitterLogin.session) });
    assertEquals(res.status, 404);
    assertEquals((await res.json()).error, GENERIC);
  });
});
