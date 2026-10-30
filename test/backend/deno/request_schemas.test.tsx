// Contract tests for server/schemas.tsx — the zod bodies that guard every
// mutating route via @hono/zod-validator.
//
// Why these deserve direct tests rather than incidental route coverage:
//   * The cross-field .refine()/.superRefine() rules are the interesting part
//     (grant-form exclusivity, delegate window ordering, five-stage custody
//     config). A route test that happens to send a valid body never exercises
//     the rejecting branch, so a refinement could be deleted and every route
//     suite would still pass.
//   * The grant-form rules are SECURITY rules: `grants` (per-org scoped) and
//     `grantFullAdmin`/`roleKeys` (all-global) must never be mixed in one
//     request, because that is how an org-scoped admin would smuggle a global
//     grant past the authority scoping in addendum-202/203.
//   * Defaults (`.default([])`) are part of the route contract — handlers read
//     the parsed value and assume the arrays exist.
//
// Pure schema parsing: no database, no HTTP.
import { assert, assertEquals } from "jsr:@std/assert";
import {
  acceptInviteSchema,
  addDelegateSchema,
  approveUserSchema,
  changePasswordSchema,
  createSystemSchema,
  inviteUserSchema,
  loginSchema,
  signupSchema,
  twoFaVerifySchema,
  updateSystemSchema,
  updateUserRolesSchema,
} from "../../../server/schemas.tsx";

const UUID_A = "00000000-0000-7000-8000-00000000000a";

// The five agency custody stages, in the schema's declared enum order. A valid
// custodyStageConfigs payload is either all five or none.
const ALL_STAGES = [
  "prepare",
  "initiate_handover",
  "verify_return",
  "return_to_inventory",
  "investigate_exception",
].map((stage) => ({
  stage,
  agencyTeamId: UUID_A,
  instructions: null,
  dueInHours: 24,
}));

// Collect the human-facing messages zod produced, so tests can assert the
// specific rule that fired rather than merely "it failed".
function messages(result: { success: boolean; error?: { issues: Array<{ message: string }> } }): string[] {
  return result.success ? [] : (result.error?.issues ?? []).map((i) => i.message);
}

Deno.test("auth bodies: required-field contracts", async (t) => {
  await t.step("signup: positive", () => {
    const out = signupSchema.safeParse({ fullName: "Ada", email: "a@b.co", password: "pw" });
    assertEquals(out.success, true);
  });

  await t.step("signup: negative — each missing/empty field is rejected", () => {
    for (const body of [
      { fullName: "", email: "a@b.co", password: "pw" },
      { fullName: "Ada", email: "", password: "pw" },
      { fullName: "Ada", email: "a@b.co", password: "" },
      { email: "a@b.co", password: "pw" },
      {},
    ]) {
      assertEquals(signupSchema.safeParse(body).success, false, JSON.stringify(body));
    }
  });

  await t.step("signup: negative — fullName over 100 chars", () => {
    const out = signupSchema.safeParse({ fullName: "x".repeat(101), email: "a@b.co", password: "pw" });
    assertEquals(out.success, false);
    assert(
      messages(out).some((m) => m.includes("1-100 characters")),
      `expected the length message, got ${JSON.stringify(messages(out))}`,
    );
  });

  await t.step("login / 2fa / accept-invite / change-password: positive + empty-string negative", () => {
    assertEquals(loginSchema.safeParse({ email: "a@b.co", password: "pw" }).success, true);
    assertEquals(loginSchema.safeParse({ email: "", password: "pw" }).success, false);

    assertEquals(twoFaVerifySchema.safeParse({ code: "123456" }).success, true);
    assertEquals(twoFaVerifySchema.safeParse({ code: "" }).success, false);

    assertEquals(acceptInviteSchema.safeParse({ token: "t", password: "pw" }).success, true);
    assertEquals(acceptInviteSchema.safeParse({ token: "", password: "pw" }).success, false);

    assertEquals(changePasswordSchema.safeParse({ currentPassword: "a", newPassword: "b" }).success, true);
    assertEquals(changePasswordSchema.safeParse({ currentPassword: "a", newPassword: "" }).success, false);
  });

  await t.step("2fa: the schema does NOT constrain the code to 6 digits", () => {
    // Documents real behaviour: length/shape is verified downstream against
    // the TOTP secret, so the schema deliberately accepts any non-empty
    // string. Pinning this stops a future 'tightening' from silently changing
    // the failure mode from "invalid code" (401) to a 400 schema error.
    assertEquals(twoFaVerifySchema.safeParse({ code: "abc" }).success, true);
  });
});

Deno.test("grant-form exclusivity — scoped `grants` may never be mixed with the global form", async (t) => {
  const base = { fullName: "Ada", email: "a@b.co", affiliation: "agency" as const };

  await t.step("invite: positive — the scoped `grants` form alone", () => {
    const out = inviteUserSchema.safeParse({
      ...base,
      grants: [{ roleKey: "user_admin", organizationId: UUID_A }],
    });
    assertEquals(out.success, true);
  });

  await t.step("invite: positive — the legacy global form alone", () => {
    assertEquals(
      inviteUserSchema.safeParse({ ...base, grantFullAdmin: true }).success,
      true,
    );
    assertEquals(
      inviteUserSchema.safeParse({ ...base, roleKeys: ["user_admin"] }).success,
      true,
    );
  });

  await t.step("invite: NEGATIVE — grants + grantFullAdmin is rejected", () => {
    const out = inviteUserSchema.safeParse({
      ...base,
      grantFullAdmin: true,
      grants: [{ roleKey: "user_admin", organizationId: null }],
    });
    assertEquals(out.success, false);
    assert(messages(out).some((m) => m.includes("not both")), JSON.stringify(messages(out)));
  });

  await t.step("invite: NEGATIVE — grants + non-empty roleKeys is rejected", () => {
    const out = inviteUserSchema.safeParse({
      ...base,
      roleKeys: ["user_admin"],
      grants: [{ roleKey: "user_admin", organizationId: null }],
    });
    assertEquals(out.success, false);
  });

  await t.step("invite: boundary — grants + EMPTY roleKeys is allowed", () => {
    // The refine only trips on a non-empty roleKeys array; an empty one is
    // treated as "the global form was not used".
    assertEquals(
      inviteUserSchema.safeParse({
        ...base,
        roleKeys: [],
        grants: [{ roleKey: "user_admin", organizationId: null }],
      }).success,
      true,
    );
  });

  await t.step("approve: the same exclusivity rule applies", () => {
    assertEquals(approveUserSchema.safeParse({ affiliation: "vendor" }).success, true);
    assertEquals(
      approveUserSchema.safeParse({
        affiliation: "vendor",
        grants: [{ roleKey: "user_admin", organizationId: null }],
      }).success,
      true,
    );
    assertEquals(
      approveUserSchema.safeParse({
        affiliation: "vendor",
        grantFullAdmin: true,
        grants: [{ roleKey: "user_admin", organizationId: null }],
      }).success,
      false,
    );
  });

  await t.step("approve: negative — affiliation is a closed enum", () => {
    assertEquals(approveUserSchema.safeParse({ affiliation: "contractor" }).success, false);
    assertEquals(approveUserSchema.safeParse({}).success, false);
  });

  await t.step("negative: a grant's organizationId must be a UUID or null, never a bare string", () => {
    assertEquals(
      approveUserSchema.safeParse({
        affiliation: "agency",
        grants: [{ roleKey: "user_admin", organizationId: "not-a-uuid" }],
      }).success,
      false,
    );
    // null is the documented "global grant" marker and must stay valid.
    assertEquals(
      approveUserSchema.safeParse({
        affiliation: "agency",
        grants: [{ roleKey: "user_admin", organizationId: null }],
      }).success,
      true,
    );
  });

  await t.step("organizationIds: optional, UUID-typed, capped at 50", () => {
    const ok = { ...base, organizationIds: [UUID_A] };
    assertEquals(inviteUserSchema.safeParse(ok).success, true);
    assertEquals(inviteUserSchema.safeParse({ ...base, organizationIds: [] }).success, true);
    assertEquals(inviteUserSchema.safeParse({ ...base, organizationIds: ["nope"] }).success, false);
    assertEquals(
      inviteUserSchema.safeParse({ ...base, organizationIds: Array(51).fill(UUID_A) }).success,
      false,
    );
  });
});

Deno.test("updateUserRoles — EXACTLY one of roleKeys or grants", async (t) => {
  await t.step("positive: roleKeys alone", () => {
    assertEquals(updateUserRolesSchema.safeParse({ roleKeys: ["user_admin"] }).success, true);
    // An empty array is still "the roleKeys form" — it means "revoke all".
    assertEquals(updateUserRolesSchema.safeParse({ roleKeys: [] }).success, true);
  });

  await t.step("positive: grants alone", () => {
    assertEquals(
      updateUserRolesSchema.safeParse({ grants: [{ roleKey: "user_admin", organizationId: null }] }).success,
      true,
    );
  });

  await t.step("NEGATIVE: both forms at once", () => {
    const out = updateUserRolesSchema.safeParse({
      roleKeys: ["user_admin"],
      grants: [{ roleKey: "user_admin", organizationId: null }],
    });
    assertEquals(out.success, false);
    assert(messages(out).some((m) => m.includes("exactly one")), JSON.stringify(messages(out)));
  });

  await t.step("NEGATIVE: neither form (an empty body is not a no-op)", () => {
    assertEquals(updateUserRolesSchema.safeParse({}).success, false);
  });
});

Deno.test("createSystem / updateSystem", async (t) => {
  const valid = {
    name: "HR Information System",
    shortCode: "HRIS",
    primaryOwnerId: "u1",
    agencyClusterId: "c1",
  };

  await t.step("positive: minimal body, and the array defaults materialise", () => {
    const out = createSystemSchema.safeParse(valid);
    assertEquals(out.success, true);
    if (out.success) {
      // Handlers index these directly; the defaults are part of the contract.
      assertEquals(out.data.vendorClusterIds, []);
      assertEquals(out.data.workflowDefinition, []);
      assertEquals(out.data.custodyStageConfigs, []);
      assertEquals(out.data.participantOrganizationIds, []);
    }
  });

  await t.step("negative: each required field missing", () => {
    for (const key of ["name", "shortCode", "primaryOwnerId", "agencyClusterId"] as const) {
      const body: Record<string, unknown> = { ...valid };
      delete body[key];
      assertEquals(createSystemSchema.safeParse(body).success, false, `missing ${key} must fail`);
      assertEquals(
        createSystemSchema.safeParse({ ...valid, [key]: "" }).success,
        false,
        `empty ${key} must fail`,
      );
    }
  });

  await t.step("negative: length ceilings (shortCode 10, name 100, description 500)", () => {
    assertEquals(createSystemSchema.safeParse({ ...valid, shortCode: "x".repeat(11) }).success, false);
    assertEquals(createSystemSchema.safeParse({ ...valid, name: "x".repeat(101) }).success, false);
    assertEquals(createSystemSchema.safeParse({ ...valid, description: "x".repeat(501) }).success, false);
    assertEquals(createSystemSchema.safeParse({ ...valid, awsRoleArnNote: "x".repeat(501) }).success, false);
    // At the limit is fine.
    assertEquals(createSystemSchema.safeParse({ ...valid, shortCode: "x".repeat(10) }).success, true);
    assertEquals(createSystemSchema.safeParse({ ...valid, description: "x".repeat(500) }).success, true);
  });

  await t.step("custodyStageConfigs: all five agency stages, or none at all", () => {
    // 0 rows = "not configured" and is allowed.
    assertEquals(createSystemSchema.safeParse({ ...valid, custodyStageConfigs: [] }).success, true);
    // The full five-stage set is the other legal shape.
    assertEquals(
      createSystemSchema.safeParse({ ...valid, custodyStageConfigs: ALL_STAGES }).success,
      true,
    );
    // A partial set is exactly the bug this refine exists to stop.
    const partial = createSystemSchema.safeParse({
      ...valid,
      custodyStageConfigs: ALL_STAGES.slice(0, 2),
    });
    assertEquals(partial.success, false);
    assert(
      messages(partial).some((m) => m.includes("all five agency stages")),
      JSON.stringify(messages(partial)),
    );
  });

  await t.step("custodyStageConfigs: per-row field rules are enforced", () => {
    const bad = (patch: Record<string, unknown>) =>
      createSystemSchema.safeParse({
        ...valid,
        custodyStageConfigs: [{ ...ALL_STAGES[0], ...patch }, ...ALL_STAGES.slice(1)],
      }).success;
    assertEquals(bad({ stage: "not_a_stage" }), false);      // closed enum
    assertEquals(bad({ agencyTeamId: "not-a-uuid" }), false); // uuid
    assertEquals(bad({ dueInHours: 0 }), false);              // >= 1
    assertEquals(bad({ dueInHours: 8761 }), false);           // <= 8760 (1 year)
    assertEquals(bad({ dueInHours: 1.5 }), false);            // integer
    assertEquals(bad({ dueInHours: null }), true);            // nullable is allowed
    assertEquals(bad({ instructions: null }), true);          // nullable is allowed
    assertEquals(bad({ instructions: "x".repeat(1001) }), false);
  });

  await t.step("updateSystem: every field optional (a no-op PATCH parses)", () => {
    assertEquals(updateSystemSchema.safeParse({}).success, true);
    assertEquals(updateSystemSchema.safeParse({ name: "New name" }).success, true);
    assertEquals(updateSystemSchema.safeParse({ name: "x".repeat(101) }).success, false);
  });

  await t.step("updateSystem: custodyStageConfigs, when present, must be exactly 5", () => {
    assertEquals(updateSystemSchema.safeParse({ custodyStageConfigs: [ALL_STAGES[0]] }).success, false);
    assertEquals(updateSystemSchema.safeParse({ custodyStageConfigs: ALL_STAGES }).success, true);
  });
});

Deno.test("addDelegate — time-bound window ordering (addendum-113)", async (t) => {
  const FROM = "2026-08-24T00:00:00.000Z";
  const UNTIL = "2026-08-25T00:00:00.000Z";

  await t.step("positive: no window (an open-ended delegation)", () => {
    assertEquals(addDelegateSchema.safeParse({ delegateUserId: "u1" }).success, true);
  });

  await t.step("positive: null window bounds are accepted (nullish)", () => {
    assertEquals(
      addDelegateSchema.safeParse({ delegateUserId: "u1", activeFrom: null, activeUntil: null }).success,
      true,
    );
  });

  await t.step("positive: a well-ordered window", () => {
    assertEquals(
      addDelegateSchema.safeParse({ delegateUserId: "u1", activeFrom: FROM, activeUntil: UNTIL }).success,
      true,
    );
  });

  await t.step("positive: only one bound present — the ordering rule does not apply", () => {
    assertEquals(addDelegateSchema.safeParse({ delegateUserId: "u1", activeFrom: FROM }).success, true);
    assertEquals(addDelegateSchema.safeParse({ delegateUserId: "u1", activeUntil: UNTIL }).success, true);
  });

  await t.step("NEGATIVE: reversed window", () => {
    const out = addDelegateSchema.safeParse({
      delegateUserId: "u1",
      activeFrom: UNTIL,
      activeUntil: FROM,
    });
    assertEquals(out.success, false);
    assert(messages(out).some((m) => m.includes("after activeFrom")), JSON.stringify(messages(out)));
  });

  await t.step("NEGATIVE: a zero-length window (from === until) is empty, not valid", () => {
    const out = addDelegateSchema.safeParse({
      delegateUserId: "u1",
      activeFrom: FROM,
      activeUntil: FROM,
    });
    assertEquals(out.success, false);
  });

  await t.step("NEGATIVE: non-ISO timestamps, and a missing delegate", () => {
    assertEquals(
      addDelegateSchema.safeParse({ delegateUserId: "u1", activeFrom: "24/08/2026" }).success,
      false,
    );
    assertEquals(addDelegateSchema.safeParse({ delegateUserId: "" }).success, false);
    assertEquals(addDelegateSchema.safeParse({}).success, false);
  });
});
