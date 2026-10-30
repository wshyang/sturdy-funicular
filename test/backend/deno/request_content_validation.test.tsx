// Direct contract tests for server/request-helpers.tsx's validateContent() —
// the shared guard that every break-glass request submission and resubmission
// passes through before anything is written.
//
// Why direct rather than via the route: validateContent has ~11 distinct
// rejection branches (field lengths, timestamp parsing, window ordering,
// asset identity/ownership/liveness, duplicate selection). Route-level suites
// exercise the happy path plus one or two failures, so most branches — and
// their exact operator-facing messages — were never asserted. A regression in
// any of them either lets an invalid request through or changes a 400's text.
//
// This suite is DB-backed (it resolves real assets through assets.get) but
// makes no HTTP calls: it drives the helper directly, which is what lets it
// reach the asset-liveness and cross-system branches cheaply.
import { assertEquals, assert } from "jsr:@std/assert";
import {
  createActiveUser,
  createAdmin,
  createAsset,
  createWiredSystem,
  uniqueEmail,
  wipeDatabase,
} from "./helpers.tsx";
import { validateContent } from "../../../server/request-helpers.tsx";
import { assets } from "../../../server/db.tsx";

const START = "2026-09-01T09:00:00.000Z";
const END = "2026-09-01T17:00:00.000Z";

Deno.test("validateContent — the shared request-body guard", async (t) => {
  await wipeDatabase();

  const admin = await createAdmin("ValidateAdmin!2026");
  const owner = await createActiveUser({
    fullName: "Content Owner",
    email: uniqueEmail("contentowner"),
    password: "OwnerPass!2026",
    affiliation: "agency",
  });
  const { system } = await createWiredSystem(admin.id, owner);
  const otherWorld = await createWiredSystem(admin.id, owner);

  const asset = await createAsset(system.id);
  const secondAsset = await createAsset(system.id);
  const foreignAsset = await createAsset(otherWorld.system.id);

  // A body that passes every rule — each negative case below is this, with
  // exactly one field spoiled, so the assertion isolates one branch.
  const validBody = () => ({
    justification: "Emergency access to restore the payroll batch job.",
    srNumber: "SR-12345",
    activityStartAt: START,
    activityEndAt: END,
    credentialItems: [{ assetId: asset.id, hostnameDescription: "primary db" }],
  });

  await t.step("positive: a well-formed body resolves assets and normalises timestamps", async () => {
    const out = await validateContent(validBody(), system.id);
    assertEquals(out.error, undefined);
    assertEquals(out.startISO, START);
    assertEquals(out.endISO, END);
    assertEquals(out.resolvedAssets?.size, 1);
    assert(out.resolvedAssets?.has(asset.id));
  });

  await t.step("positive: timestamps in other formats are normalised to ISO", async () => {
    const out = await validateContent(
      { ...validBody(), activityStartAt: "2026-09-01T09:00:00Z", activityEndAt: "2026-09-01T17:00:00+00:00" },
      system.id,
    );
    assertEquals(out.error, undefined);
    assertEquals(out.startISO, START);
    assertEquals(out.endISO, END);
  });

  await t.step("positive: multiple distinct assets all resolve", async () => {
    const out = await validateContent(
      {
        ...validBody(),
        credentialItems: [{ assetId: asset.id }, { assetId: secondAsset.id }],
      },
      system.id,
    );
    assertEquals(out.error, undefined);
    assertEquals(out.resolvedAssets?.size, 2);
  });

  await t.step("positive: hostnameDescription is optional", async () => {
    const out = await validateContent(
      { ...validBody(), credentialItems: [{ assetId: asset.id }] },
      system.id,
    );
    assertEquals(out.error, undefined);
  });

  // ── justification / srNumber ──────────────────────────────────────────────

  await t.step("negative: justification missing, empty, or over 2000 chars", async () => {
    for (const justification of [undefined, "", "   ", "x".repeat(2001)]) {
      const out = await validateContent({ ...validBody(), justification }, system.id);
      assert(out.error, `justification=${JSON.stringify(justification)?.slice(0, 20)} must be rejected`);
      assert(out.error!.includes("Justification"), out.error);
    }
  });

  await t.step("boundary: justification of exactly 2000 chars is accepted", async () => {
    const out = await validateContent({ ...validBody(), justification: "x".repeat(2000) }, system.id);
    assertEquals(out.error, undefined);
  });

  await t.step("negative: srNumber missing, empty, or over 100 chars", async () => {
    for (const srNumber of [undefined, "", "x".repeat(101)]) {
      const out = await validateContent({ ...validBody(), srNumber }, system.id);
      assert(out.error, `srNumber=${JSON.stringify(srNumber)?.slice(0, 20)} must be rejected`);
      assert(out.error!.includes("SR number"), out.error);
    }
  });

  // ── activity window ───────────────────────────────────────────────────────

  await t.step("negative: either timestamp absent", async () => {
    const noStart = await validateContent({ ...validBody(), activityStartAt: undefined }, system.id);
    assertEquals(noStart.error, "Activity start and end times are required.");
    const noEnd = await validateContent({ ...validBody(), activityEndAt: undefined }, system.id);
    assertEquals(noEnd.error, "Activity start and end times are required.");
  });

  await t.step("negative: unparseable timestamps are reported per-field", async () => {
    const badStart = await validateContent({ ...validBody(), activityStartAt: "not-a-date" }, system.id);
    assertEquals(badStart.error, "Activity start time is invalid.");
    const badEnd = await validateContent({ ...validBody(), activityEndAt: "31/02/2026" }, system.id);
    assertEquals(badEnd.error, "Activity end time is invalid.");
  });

  await t.step("negative: end before start, and a zero-length window", async () => {
    const reversed = await validateContent(
      { ...validBody(), activityStartAt: END, activityEndAt: START },
      system.id,
    );
    assertEquals(reversed.error, "Activity end time must be after start time.");

    const zero = await validateContent(
      { ...validBody(), activityStartAt: START, activityEndAt: START },
      system.id,
    );
    assertEquals(zero.error, "Activity end time must be after start time.");
  });

  // ── credential items ──────────────────────────────────────────────────────

  await t.step("negative: credentialItems absent, empty, or not an array", async () => {
    for (const credentialItems of [undefined, [], "nope", {}, null]) {
      const out = await validateContent({ ...validBody(), credentialItems }, system.id);
      assertEquals(
        out.error,
        "At least one credential item (a selected asset) is required.",
        `credentialItems=${JSON.stringify(credentialItems)}`,
      );
    }
  });

  await t.step("negative: an item without a usable assetId", async () => {
    for (const item of [{}, { assetId: "" }, { assetId: 42 }, { assetId: null }]) {
      const out = await validateContent({ ...validBody(), credentialItems: [item] }, system.id);
      assertEquals(
        out.error,
        "Each credential item must reference a selected asset.",
        JSON.stringify(item),
      );
    }
  });

  await t.step("negative: the same asset selected twice", async () => {
    const out = await validateContent(
      { ...validBody(), credentialItems: [{ assetId: asset.id }, { assetId: asset.id }] },
      system.id,
    );
    assertEquals(out.error, "The same asset was selected more than once.");
  });

  await t.step("negative: hostnameDescription over 200 chars", async () => {
    const out = await validateContent(
      {
        ...validBody(),
        credentialItems: [{ assetId: asset.id, hostnameDescription: "x".repeat(201) }],
      },
      system.id,
    );
    assert(out.error?.includes("Hostname description"), out.error);
  });

  await t.step("negative: an asset id that does not exist", async () => {
    const out = await validateContent(
      { ...validBody(), credentialItems: [{ assetId: "00000000-0000-7000-8000-0000000000ff" }] },
      system.id,
    );
    assertEquals(
      out.error,
      "Each credential item must reference a valid, active asset for this system.",
    );
  });

  await t.step("negative: cross-system asset — a real asset belonging to ANOTHER system", async () => {
    // The important isolation branch: the asset exists and is live, but is not
    // this system's, so it must not be attachable to this system's request.
    const out = await validateContent(
      { ...validBody(), credentialItems: [{ assetId: foreignAsset.id }] },
      system.id,
    );
    assertEquals(
      out.error,
      "Each credential item must reference a valid, active asset for this system.",
    );
  });

  await t.step("negative: a soft-deleted (expired) asset of THIS system", async () => {
    const retired = await createAsset(system.id);
    await assets.update(retired.id, { expiresAfter: new Date().toISOString() } as never);
    const out = await validateContent(
      { ...validBody(), credentialItems: [{ assetId: retired.id }] },
      system.id,
    );
    assertEquals(
      out.error,
      "Each credential item must reference a valid, active asset for this system.",
    );
  });

  await t.step("ordering: field validation precedes asset resolution", async () => {
    // A body that is wrong in two ways must report the FIRST rule, so the
    // operator fixes fields before hunting a (valid) asset id.
    const out = await validateContent(
      { ...validBody(), justification: "", credentialItems: [{ assetId: "nope" }] },
      system.id,
    );
    assert(out.error?.includes("Justification"), out.error);
  });
});
