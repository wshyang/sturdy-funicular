// Coverage: POST/DELETE /owner/systems/:id/delegates[/:delegateId] and
// GET /owner/statistics — the validation arms behind the §E owner element
// stories that existing files leave unpinned. owner.test.tsx owns the
// positive add/list/remove (+ notification), the self/non-primary-owner/
// vendor/cross-org/unanchored pins; time_bound_delegations.test.tsx owns the
// window arms. This suite adds: unknown-system 404, inactive-target 400,
// already-owner 400, duplicate 400, delete 404, and the /owner/statistics
// range-validation 400s + empty-owner 200 shape.
import { wipeDatabase, createAdmin, createActiveUser, loginAs, uniqueEmail, createWiredSystem } from "./helpers.tsx";
import { systemOwners } from "../../../server/db.tsx";
import { run01Steps } from "./owner-delegate-guards-suite/01-delegate-validation.steps.ts";
import { run02Steps } from "./owner-delegate-guards-suite/02-statistics-validation.steps.ts";
import type { SuiteContext } from "./owner-delegate-guards-suite/00-context.ts";

Deno.test("owner_delegate_guards", async (t) => {
  const context = {} as SuiteContext;

  await t.step("setup: wired system (agency cluster deliberately ORG-LESS) + fixture targets", async () => {
    await wipeDatabase();
    const admin = await createAdmin("OwnerGuardAdmin!2026");
    context.adminId = admin.id;
    context.adminSession = ((await loginAs(admin.email, "OwnerGuardAdmin!2026")) as any).session;

    const owner = await createActiveUser({ fullName: "Owner", email: uniqueEmail("og-owner"), password: "OwnerPass!2026", affiliation: "agency" });
    context.ownerId = owner.id;
    context.ownerSession = ((await loginAs(owner.email, "OwnerPass!2026")) as any).session;

    const { system, agencyCluster } = await createWiredSystem(admin.id, owner);
    context.systemId = system.id;
    context.agencyClusterId = agencyCluster.id;

    context.delegateCandidateId = (await createActiveUser({ fullName: "Candidate", email: uniqueEmail("og-cand"), password: "CandPass!2026", affiliation: "agency" })).id;

    const backup = await createActiveUser({ fullName: "BackupOwner", email: uniqueEmail("og-backup"), password: "BackupPass!2026", affiliation: "agency" });
    context.backupOwnerId = backup.id;
    await systemOwners.create({
      id: crypto.randomUUID(), systemId: system.id, userId: backup.id, kind: "backup", createdBy: admin.id, createdAt: new Date().toISOString(),
    });
  });

  await run01Steps(t, context);
  await run02Steps(t, context);
});
