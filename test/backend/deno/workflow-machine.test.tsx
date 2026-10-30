// Coverage: server/workflow-machine.tsx's getNextState — fast, DB-free unit
// tests of every request-lifecycle transition pair. See
// addendum-040-xstate-workflow-refactor.md. No wipeDatabase()/fixture setup
// needed — this is pure in-memory transition logic.
import { assertEquals, assertThrows } from "jsr:@std/assert";
import { getNextState } from "../../../server/workflow-machine.tsx";

Deno.test("workflow-machine: getNextState", async (t) => {
  await t.step("SUBMIT: hasApprovalSteps=true -> submitted, ordinal 2", () => {
    const next = getNextState({ status: "returned_to_vendor", currentStepOrdinal: 5 }, { type: "SUBMIT", hasApprovalSteps: true });
    assertEquals(next, { status: "submitted", currentStepOrdinal: 2 });
  });

  await t.step("SUBMIT: hasApprovalSteps=false -> under_review at owner terminal, ordinal 0", () => {
    const next = getNextState({ status: "returned_to_vendor", currentStepOrdinal: 5 }, { type: "SUBMIT", hasApprovalSteps: false });
    assertEquals(next, { status: "under_review", currentStepOrdinal: 0 });
  });

  await t.step("STEP_APPROVE from submitted: hasNextStep=true -> under_review, advances to nextOrdinal", () => {
    const next = getNextState({ status: "submitted", currentStepOrdinal: 2 }, { type: "STEP_APPROVE", hasNextStep: true, nextOrdinal: 3 });
    assertEquals(next, { status: "under_review", currentStepOrdinal: 3 });
  });

  await t.step("STEP_APPROVE from submitted: hasNextStep=false -> under_review at owner terminal (ordinal 0)", () => {
    const next = getNextState({ status: "submitted", currentStepOrdinal: 2 }, { type: "STEP_APPROVE", hasNextStep: false, nextOrdinal: 0 });
    assertEquals(next, { status: "under_review", currentStepOrdinal: 0 });
  });

  await t.step("STEP_APPROVE from under_review at a mid-chain step: hasNextStep=true -> advances further", () => {
    const next = getNextState({ status: "under_review", currentStepOrdinal: 3 }, { type: "STEP_APPROVE", hasNextStep: true, nextOrdinal: 4 });
    assertEquals(next, { status: "under_review", currentStepOrdinal: 4 });
  });

  await t.step("STEP_APPROVE from under_review at the final step: hasNextStep=false -> owner terminal", () => {
    const next = getNextState({ status: "under_review", currentStepOrdinal: 4 }, { type: "STEP_APPROVE", hasNextStep: false, nextOrdinal: 0 });
    assertEquals(next, { status: "under_review", currentStepOrdinal: 0 });
  });

  await t.step("STEP_RETURN: -> returned_to_vendor, ordinal deliberately UNCHANGED (known real-behavior inconsistency, not reset)", () => {
    const next = getNextState({ status: "under_review", currentStepOrdinal: 3 }, { type: "STEP_RETURN" });
    assertEquals(next, { status: "returned_to_vendor", currentStepOrdinal: 3 });
  });

  await t.step("STEP_REJECT: -> rejected, ordinal deliberately UNCHANGED", () => {
    const next = getNextState({ status: "submitted", currentStepOrdinal: 2 }, { type: "STEP_REJECT" });
    assertEquals(next, { status: "rejected", currentStepOrdinal: 2 });
  });

  await t.step("OWNER_APPROVE from owner terminal: -> approved", () => {
    const next = getNextState({ status: "under_review", currentStepOrdinal: 0 }, { type: "OWNER_APPROVE" });
    assertEquals(next, { status: "approved", currentStepOrdinal: 0 });
  });

  await t.step("OWNER_RETURN: -> returned_to_vendor, ordinal deliberately UNCHANGED (0, since owner terminal)", () => {
    const next = getNextState({ status: "under_review", currentStepOrdinal: 0 }, { type: "OWNER_RETURN" });
    assertEquals(next, { status: "returned_to_vendor", currentStepOrdinal: 0 });
  });

  await t.step("OWNER_REJECT: -> rejected, ordinal deliberately UNCHANGED", () => {
    const next = getNextState({ status: "under_review", currentStepOrdinal: 0 }, { type: "OWNER_REJECT" });
    assertEquals(next, { status: "rejected", currentStepOrdinal: 0 });
  });

  await t.step("ISSUE_CREDENTIAL from approved: -> credential_issued", () => {
    const next = getNextState({ status: "approved", currentStepOrdinal: 0 }, { type: "ISSUE_CREDENTIAL" });
    assertEquals(next, { status: "credential_issued", currentStepOrdinal: 0 });
  });

  await t.step("CLOSE from credential_issued: -> closed", () => {
    const next = getNextState({ status: "credential_issued", currentStepOrdinal: 0 }, { type: "CLOSE" });
    assertEquals(next, { status: "closed", currentStepOrdinal: 0 });
  });

  await t.step("ADMIN_RESET: hasApprovalSteps=true -> returned_to_vendor, ordinal 2, resolvable from ANY non-closed status (bypasses the normal graph)", () => {
    for (const status of ["submitted", "under_review", "returned_to_vendor", "rejected", "approved", "credential_issued"] as const) {
      const next = getNextState({ status, currentStepOrdinal: 3 }, { type: "ADMIN_RESET", hasApprovalSteps: true });
      assertEquals(next, { status: "returned_to_vendor", currentStepOrdinal: 2 }, `expected reset from ${status}`);
    }
  });

  await t.step("ADMIN_RESET: hasApprovalSteps=false -> returned_to_vendor, ordinal 0", () => {
    const next = getNextState({ status: "rejected", currentStepOrdinal: 3 }, { type: "ADMIN_RESET", hasApprovalSteps: false });
    assertEquals(next, { status: "returned_to_vendor", currentStepOrdinal: 0 });
  });

  await t.step("throws on an unrecognized status (defensive — should never happen with real DB rows)", () => {
    assertThrows(() => getNextState({ status: "bogus" as any, currentStepOrdinal: 0 }, { type: "OWNER_APPROVE" }));
  });
});
