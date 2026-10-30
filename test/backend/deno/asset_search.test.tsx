// Coverage: GET /systems/:id/assets/search — the non-admin autocomplete
// route powering request-submission's asset-gated combobox. See
// addendum-039-asset-gated-submission.md and server/routes-assets.tsx.
import { assertEquals, assertExists } from "jsr:@std/assert";
import {
  req, authHeaders, wipeDatabase, createAdmin, createActiveUser, loginAs, uniqueEmail,
  createWiredSystem, addMember, addServingMember, createAsset,
} from "./helpers.tsx";
import { assets } from "../../../server/db.tsx";

Deno.test("asset_search", async (t) => {
  let adminId: string;

  await t.step("setup", async () => {
    await wipeDatabase();
    const admin = await createAdmin("AssetSearchAdmin!2026");
    adminId = admin.id;
  });

  await t.step("search: positive — an active submitter finds active assets matching a >=4-char prefix", async () => {
    const owner = await createActiveUser({ fullName: "SearchOwner1", email: uniqueEmail("searchowner1"), password: "OwnerPass!2026", affiliation: "agency" });
    const { system, vendorL1 } = await createWiredSystem(adminId, owner);
    const submitter = await createActiveUser({ fullName: "SearchSubmitter1", email: uniqueEmail("searchsub1"), password: "SubmitPass!2026", affiliation: "vendor" });
    await addServingMember(vendorL1, submitter, adminId);
    await createAsset(system.id, { hostname: "prod-db-01" });
    await createAsset(system.id, { hostname: "prod-web-01" });
    await createAsset(system.id, { hostname: "staging-db-01" });

    const login = await loginAs(submitter.email, "SubmitPass!2026") as any;
    const res = await req(`/systems/${system.id}/assets/search?q=prod`, { headers: authHeaders(login.session) });
    assertEquals(res.status, 200);
    const data = await res.json();
    assertEquals(data.assets.length, 2);
    assertEquals(data.assets.every((a: any) => a.hostname.startsWith("prod")), true);
  });

  await t.step("search: positive — invalidated assets are excluded from results", async () => {
    const owner = await createActiveUser({ fullName: "SearchOwner2", email: uniqueEmail("searchowner2"), password: "OwnerPass!2026", affiliation: "agency" });
    const { system, vendorL1 } = await createWiredSystem(adminId, owner);
    const submitter = await createActiveUser({ fullName: "SearchSubmitter2", email: uniqueEmail("searchsub2"), password: "SubmitPass!2026", affiliation: "vendor" });
    await addServingMember(vendorL1, submitter, adminId);
    await createAsset(system.id, { hostname: "active-host-01" });
    const invalidated = await createAsset(system.id, { hostname: "active-host-02" });
    await assets.update(invalidated.id, { expiresAfter: new Date().toISOString() });

    const login = await loginAs(submitter.email, "SubmitPass!2026") as any;
    const res = await req(`/systems/${system.id}/assets/search?q=active`, { headers: authHeaders(login.session) });
    assertEquals(res.status, 200);
    const data = await res.json();
    assertEquals(data.assets.length, 1);
    assertEquals(data.assets[0].hostname, "active-host-01");
  });

  await t.step("search: negative — q shorter than 4 characters is rejected", async () => {
    const owner = await createActiveUser({ fullName: "SearchOwner3", email: uniqueEmail("searchowner3"), password: "OwnerPass!2026", affiliation: "agency" });
    const { system, vendorL1 } = await createWiredSystem(adminId, owner);
    const submitter = await createActiveUser({ fullName: "SearchSubmitter3", email: uniqueEmail("searchsub3"), password: "SubmitPass!2026", affiliation: "vendor" });
    await addServingMember(vendorL1, submitter, adminId);
    await createAsset(system.id, { hostname: "abcdefgh" });

    const login = await loginAs(submitter.email, "SubmitPass!2026") as any;
    const res = await req(`/systems/${system.id}/assets/search?q=abc`, { headers: authHeaders(login.session) });
    assertEquals(res.status, 400);
  });

  await t.step("search: negative — a session-scoping substitution: a user with no submitter relationship to this system is forbidden", async () => {
    const owner = await createActiveUser({ fullName: "SearchOwner4", email: uniqueEmail("searchowner4"), password: "OwnerPass!2026", affiliation: "agency" });
    const { system } = await createWiredSystem(adminId, owner);
    await createAsset(system.id, { hostname: "unrelated-host" });
    const outsider = await createActiveUser({ fullName: "SearchOutsider", email: uniqueEmail("searchoutsider"), password: "OutPass!2026", affiliation: "vendor" });

    const login = await loginAs(outsider.email, "OutPass!2026") as any;
    const res = await req(`/systems/${system.id}/assets/search?q=unrelated`, { headers: authHeaders(login.session) });
    assertEquals(res.status, 403);
  });

  await t.step("search: negative — unauthenticated", async () => {
    const owner = await createActiveUser({ fullName: "SearchOwner5", email: uniqueEmail("searchowner5"), password: "OwnerPass!2026", affiliation: "agency" });
    const { system } = await createWiredSystem(adminId, owner);
    const res = await req(`/systems/${system.id}/assets/search?q=whatever`);
    assertEquals(res.status, 403);
  });

  await t.step("search: negative — system not found", async () => {
    const owner = await createActiveUser({ fullName: "SearchOwner6", email: uniqueEmail("searchowner6"), password: "OwnerPass!2026", affiliation: "agency" });
    const submitter = await createActiveUser({ fullName: "SearchSubmitter6", email: uniqueEmail("searchsub6"), password: "SubmitPass!2026", affiliation: "vendor" });
    const login = await loginAs(submitter.email, "SubmitPass!2026") as any;
    const res = await req(`/systems/00000000-0000-0000-0000-000000000999/assets/search?q=whatever`, { headers: authHeaders(login.session) });
    assertEquals(res.status, 404);
  });
});
