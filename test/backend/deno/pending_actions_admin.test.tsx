// Q12 phase-D admin oversight report (addendum-138) — GET /admin/pending-actions.
// Companion to dashboard_pending_actions.test.tsx: THAT suite pins the
// per-viewer derivation (the "who owes ME what" dashboard); THIS suite pins
// the admin aggregation ("who owes ANYONE what") and its phase-2 scoping:
//   * global UserRead ⇒ the full debtor registry (every active user scanned,
//     overdue-first ordering, org attribution rolled into each debtor row);
//   * scoped UserRead ⇒ ONLY users sharing ≥1 membership with the admin's
//     granted orgs (200-with-everything is a leak — cross_org §2 class);
//   * capability absent everywhere ⇒ the byte-identical 403.
// Zero-shot: an inactive/tombstoned debtor and a globally-scoped
// no-membership user both drop out of scope by construction.
import { assert, assertEquals } from "jsr:@std/assert";
import { defineTest } from "./harness/harness.ts";
import {
  addMember,
  addOrgMembership,
  addServingMember,
  createActiveUser,
  createAsset,
  createOrganization,
  createSingleStepAgencySystem,
  loginAs,
  uniqueEmail,
} from "./helpers.tsx";
import { query } from "../../../server/pg.tsx";
import type { User } from "../../../server/types.tsx";

const runSuffix = crypto.randomUUID().slice(0, 8);

async function grantScoped(userId: string, roleKey: string, organizationId: string, grantedBy: string): Promise<void> {
  await query(
    `INSERT INTO user_admin_role_grants (user_id, role_key, granted_by, organization_id)
     VALUES ($1, $2, $3, $4)`,
    [userId, roleKey, grantedBy, organizationId],
  );
}

async function agencyUserWithSession(label: string): Promise<{ user: User; session: string }> {
  const user = await createActiveUser({
    fullName: label,
    email: uniqueEmail(label.toLowerCase().replace(/[^a-z0-9]+/g, "-")),
    password: "Q12Report!2026",
    affiliation: "agency",
  });
  const login = await loginAs(user.email, "Q12Report!2026");
  if ("error" in login) throw new Error(`loginAs failed: ${login.error}`);
  return { user, session: login.session };
}

interface DebtorRow {
  user: { id: string; fullName: string; organizations: { id: string; name: string }[] };
  pendingActions: { key: string; urgency: string }[];
  overdueCount: number;
  dueSoonCount: number;
}

defineTest(
  "admin pending-actions report (Q12 phase-D): global registry, scoped filtering, grantless 403",
  async ({ ctx, t }) => {
    let orgA = "";
    let orgB = "";
    let reviewerInA: User;
    let isolatedUser: User;
    let scopedAdminSession = "";
    let scopedAdminId = "";

    await t.step("setup: two orgs; owing reviewer in Org A; isolated (no-org) dummy; scoped user_admin in Org A", async () => {
      orgA = (await createOrganization({ name: `Q12 Org A ${runSuffix}`, shortCode: "QA", createdBy: ctx.admin.id })).id;
      orgB = (await createOrganization({ name: `Q12 Org B ${runSuffix}`, shortCode: "QB", createdBy: ctx.admin.id })).id;

      const owner = await createActiveUser({ email: uniqueEmail("q12-owner"), password: "Q12Owner!2026", affiliation: "agency" });
      const built = await createSingleStepAgencySystem(ctx.admin.id, owner);

      const reviewer = await createActiveUser({ email: uniqueEmail("q12-reviewer"), password: "Q12Rev!2026", affiliation: "agency", fullName: `Q12 Reviewer ${runSuffix}` });
      await addMember(built.agencyL1, reviewer, ctx.admin.id);
      await addOrgMembership({ organizationId: orgA, userId: reviewer.id, addedBy: ctx.admin.id });
      reviewerInA = reviewer;

      // A debtor in Org B only — the scoped admin must NEVER see this row.
      const debtorB = await createActiveUser({ email: uniqueEmail("q12-debtor-b"), password: "Q12DebB!2026", affiliation: "agency", fullName: `Q12 Debtor B ${runSuffix}` });
      await addMember(built.agencyL1, debtorB, ctx.admin.id);
      await addOrgMembership({ organizationId: orgB, userId: debtorB.id, addedBy: ctx.admin.id });

      // A zero-org user (global plane) — outside every scoped admin's reach.
      isolatedUser = await createActiveUser({ email: uniqueEmail("q12-isolated"), password: "Q12Iso!2026", affiliation: "agency", fullName: `Q12 Isolated ${runSuffix}` });

      const admin = await agencyUserWithSession("Q12 Scoped Admin");
      await addOrgMembership({ organizationId: orgA, userId: admin.user.id, addedBy: ctx.admin.id });
      await grantScoped(admin.user.id, "user_admin", orgA, ctx.admin.id);
      scopedAdminSession = admin.session;
      scopedAdminId = admin.user.id;

      // The actual DEBT: a request parked at the L1 step both reviewers share.
      const submitter = await createActiveUser({ email: uniqueEmail("q12-sub"), password: "Q12Sub!2026", affiliation: "vendor" });
      await addServingMember(built.vendorL1, submitter, ctx.admin.id);
      const sLogin = await loginAs(submitter.email, "Q12Sub!2026");
      if ("error" in sLogin) throw new Error(`loginAs failed: ${sLogin.error}`);
      const asset = await createAsset(built.system.id, { hostname: `q12-host-${runSuffix}` });
      const submit = await ctx.actors.as(sLogin.session).post("/requests", {
        body: {
          systemId: built.system.id,
          justification: "Q12 report fixture request",
          srNumber: `SR-Q12-${runSuffix}`,
          activityStartAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          activityEndAt: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
          credentialItems: [{ assetId: asset.id, hostnameDescription: "q12 host" }],
        },
      });
      assertEquals(submit.status, 201);
    });

    await t.step("global admin sees the full debtor registry (org attribution + urgency rollup present)", async () => {
      const res = await ctx.actors.admin.get("/admin/pending-actions");
      assertEquals(res.status, 200);
      const debtors = res.json.debtors as DebtorRow[];
      const reviewerRow = debtors.find((d) => d.user.id === reviewerInA.id);
      assert(reviewerRow, "the owing L1 reviewer must appear with his pending action");
      assert(reviewerRow.pendingActions.length > 0);
      assert(reviewerRow.user.organizations.some((o) => o.id === orgA), "org attribution rolls into the debtor row");
      const bRow = debtors.find((d) => d.user.fullName === `Q12 Debtor B ${runSuffix}`);
      assert(bRow, "the Org-B debtor is visible to the GLOBAL report");
    });

    await t.step("scoped user_admin (Org A): only shared-org debtors — Org B and zero-org users never leak", async () => {
      const res = await ctx.actors.as(scopedAdminSession).get("/admin/pending-actions");
      assertEquals(res.status, 200);
      const debtors = res.json.debtors as DebtorRow[];
      const ids = debtors.map((d) => d.user.id);
      assert(ids.includes(reviewerInA.id), "the shared-org debtor stays visible");
      assert(!debtors.some((d) => d.user.fullName === `Q12 Debtor B ${runSuffix}`), "the Org-B debtor is filtered out");
      assert(!ids.includes(isolatedUser.id), "zero-org users are global-plane: out of every scoped admin's reach");
      // The scoped admin himself (a member of Org A with no debts) is simply
      // absent from the debtor list — no phantom rows.
      assert(!ids.includes(scopedAdminId) || debtors.find((d) => d.user.id === scopedAdminId)!.pendingActions.length > 0);
    });

    await t.step("capability-absent gate: a member with NO UserRead anywhere gets the byte-identical 403", async () => {
      const grantless = await agencyUserWithSession("Q12 Grantless");
      await addOrgMembership({ organizationId: orgA, userId: grantless.user.id, addedBy: ctx.admin.id });
      const res = await ctx.actors.as(grantless.session).get("/admin/pending-actions");
      assertEquals(res.status, 403);
      assert((res.json.error as string).includes("UserRead"), "byte-identical capability message");
    });

    await t.step("S-class contract: the SCOPED capability surface lists UserRead for the scoped admin (UI gating hint)", async () => {
      const res = await ctx.actors.as(scopedAdminSession).get("/admin/capabilities");
      assertEquals(res.status, 200);
      const scoped = res.json.scopedCapabilities as string[];
      assert(scoped.includes("UserRead"), "scoped UserRead surfaces for scoped-admin UI gating");
      const global = res.json.capabilities as string[];
      assert(!global.includes("UserRead"), "global set stays untouched — semantic unchanged");
    });
  },
);
