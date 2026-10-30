// Randomized-structure volume scenario: 3 systems with deliberately
// different vendor/agency cluster shapes (System A: vendor L1+L2; Systems
// B/C: vendor L1 only — fixed per the user's spec; agency side is L1-only,
// L2-only, or both, chosen randomly per system at RUN TIME), owners drawn
// randomly from a shared 4-person pool (so one person can end up owning
// and/or backing up more than one system), and 2 unique vendor L1 users per
// system each submitting a random 1-3 requests. Every request is driven
// through its full happy-path approval chain up to (but not including) the
// owner terminal decision, then every owner-pool member who ended up
// holding a primary or backup role on at least one system logs in and the
// "Pending Review" count is verified against the pre-computed expectation.
//
// Distinct from happy-path.spec.ts/rejection-flows.spec.ts's fixed 9-actor
// roster/single-system focus — this spec exercises the AGGREGATION side of
// OwnerDashboard.tsx (summed pending count across however many systems a
// given owner-pool member ended up attached to), not step-by-step
// visibility transitions.
import { test, expect } from '../helpers/harness';
import { E2E_USER_EMAIL, E2E_USER_PASSWORD } from '../global-setup';
import { login, modalByTestId, pickDateTime, submitRequestIdentityWithCapture, clickWithCapture, createAssetViaAdminUI, fillCredentialItemCombobox, pendingDashboardAction, captureBefore, captureAfter, confirmDecisionAndWait,
} from '../helpers/ui';
import { provisionRandomScenario, type RandomScenario, type SystemScenario } from '../helpers/random-owner-scenario';

const SUPERADMIN = { email: E2E_USER_EMAIL, password: E2E_USER_PASSWORD };
const RUN_ID = 'opc';

test.describe('randomized multi-system volume + owner/backup-owner pending-count verification', () => {
  test('3 systems, random structure, random owners, flooded requests, verified pending counts', async ({ page }) => {
    // Heavier than existing specs by a wide margin: provisioning up to ~17
    // actors across 3 systems' clusters/teams/workflows/mappings, up to 18
    // request submissions (each with 2 slow DateTimePicker interactions),
    // and up to 18 approval actions against live pending-dashboard rows.

    let scenario!: RandomScenario;
    const requestsBySystem = new Map<string, Array<{ srNumber: string; requestNumber: string }>>();

    await test.step('provision 3 randomly-shaped systems, owners, and personnel', async () => {
      scenario = await provisionRandomScenario(page, SUPERADMIN, RUN_ID);
      for (const sys of scenario.systems) {
        // eslint-disable-next-line no-console
        console.log(
          `[owner-pending-count] System ${sys.slot} (${sys.name}): agencyLevels=${sys.agencyLevels.join(',')} ` +
          `vendorL2=${!!sys.vendorL2Approver} primaryOwner=${sys.primaryOwner.email} backupOwner=${sys.backupOwner.email} ` +
          `requestCounts=${JSON.stringify([...sys.requestCountsByUser.entries()])}`,
        );
      }
      // Per addendum-039-asset-gated-submission.md — one asset per system,
      // reused across every request submitted to it below (hostname/
      // credential_name uniqueness across requests is never asserted on
      // downstream, only SR numbers are).
      for (const sys of scenario.systems) {
        await createAssetViaAdminUI(page, {
          systemLabel: `${sys.shortCode} — ${sys.name}`, hostname: `host-${sys.slot}.internal`, credentialName: `svc-${sys.slot}`, navigateFirst: true,
        });
      }
    });

    // ── Flood each system with each L1 user's random request count ─────────
    await test.step('vendor L1 users submit their randomly-assigned number of requests', async () => {
      for (const sys of scenario.systems) {
        const submittedRequests: Array<{ srNumber: string; requestNumber: string }> = [];
        for (const user of sys.vendorL1Users) {
          const count = sys.requestCountsByUser.get(user.email)!;
          await login(page, user.email, user.password);
          for (let i = 0; i < count; i++) {
            // Captures the vendor's own dashboard (header shows THIS actor's
            // name/role) immediately before opening the submit form — the
            // "who is doing this" context, same convention as happy-path.spec.ts.
            await clickWithCapture(
              page, `owner-pending-count-open-submit-${sys.slot}-${user.email.split('@')[0]}-${i}`,
              page.getByTestId('vendor-dashboard__open-submit-button'),
            );
            await page.getByTestId('vendor-dashboard__system-select')
              .selectOption({ label: `${sys.name} (${sys.shortCode})` });
            const srNumber = `SR-${RUN_ID}-${sys.slot}-${user.email.split('@')[0]}-${i}`;
            await page.getByTestId('vendor-dashboard__sr-number-input').fill(srNumber);
            await page.getByTestId('vendor-dashboard__justification-textarea')
              .fill(`Emergency access request ${i + 1} of ${count} for ${sys.name}.`);
            await pickDateTime(page, page.getByTestId('vendor-dashboard__activity-start-picker'), { hour: '09', minute: '00' });
            await pickDateTime(page, page.getByTestId('vendor-dashboard__activity-end-picker'), { hour: '17', minute: '00' });
            await fillCredentialItemCombobox(page.getByTestId('vendor-dashboard__credential-item'), `host-${sys.slot}.internal`, `svc-${sys.slot}`);
            const submitted = await submitRequestIdentityWithCapture(
              page, `owner-pending-count-submit-${sys.slot}-${user.email.split('@')[0]}-${i}`,
              page.getByTestId('vendor-dashboard__submit-request-button'),
            );
            submittedRequests.push({ srNumber, requestNumber: submitted.requestNumber });
          }
        }
        requestsBySystem.set(sys.slot, submittedRequests);
      }
    });

    // ── Drive every request through its own system's full approval chain,
    // stopping right before the owner terminal decision ─────────────────────
    await test.step('drive every request through its system\'s approval chain to owner-terminal', async () => {
      for (const sys of scenario.systems) {
        const submittedRequests = requestsBySystem.get(sys.slot)!;

        if (sys.vendorL2Approver) {
          await login(page, sys.vendorL2Approver.email, sys.vendorL2Approver.password);
          for (const request of submittedRequests) {
            await approveFromDashboard(page, sys, request.requestNumber, 'vendor');
          }
        }

        for (const level of sys.agencyLevels) {
          const approver = sys.agencyApproversByLevel.get(level)!;
          await login(page, approver.email, approver.password);
          for (const request of submittedRequests) {
            await approveFromDashboard(page, sys, request.requestNumber, 'agency');
          }
        }
      }
    });

    // ── Compute expected pending-review count per owner-pool member ────────
    const expectedCountByOwnerEmail = new Map<string, number>();
    for (const sys of scenario.systems) {
      const total = requestsBySystem.get(sys.slot)!.length;
      for (const ownerEmail of [sys.primaryOwner.email, sys.backupOwner.email]) {
        expectedCountByOwnerEmail.set(ownerEmail, (expectedCountByOwnerEmail.get(ownerEmail) ?? 0) + total);
      }
    }

    // ── Verify every touched owner-pool member sees the correct count ──────
    await test.step('every owner-pool member (primary and/or backup) sees the correct pending count', async () => {
      for (const owner of scenario.ownerPool) {
        const expected = expectedCountByOwnerEmail.get(owner.email);
        if (expected === undefined) continue; // this pool member wasn't assigned to any system this run

        await login(page, owner.email, owner.password);
        await clickWithCapture(page, `owner-pending-count-view-dashboard-${owner.email.split('@')[0]}`, page.getByTestId('owner-dashboard__tab-requests'));
        await expect(page.getByTestId('owner-dashboard__stat-pending-review-count')).toHaveText(String(expected));
      }
    });
  });
});

// Approval queues are contractual: every assigned request must already be
// visible and actionable in the current actor's dashboard.
async function approveFromDashboard(
  page: import('@playwright/test').Page,
  sys: SystemScenario,
  requestNumber: string,
  role: 'vendor' | 'agency',
) {
  const approve = await pendingDashboardAction(page, requestNumber, `${role}-dashboard__approve-button`);
  await clickWithCapture(page, `owner-pending-count-open-approve-${sys.slot}-${requestNumber}`, approve);
  const modal = modalByTestId(page, `${role}-dashboard__action-modal`);
  // The vendor/agency dashboards close their action modals OPTIMISTICALLY
  // (useOptimisticAction) — gate the confirm on the step-decision POST
  // response so the modal-gone assert reads server-true state.
  await captureBefore(page, `owner-pending-count-approve-${sys.slot}-${requestNumber}`);
  await confirmDecisionAndWait(page, modal.getByTestId(`${role}-dashboard__confirm-button`));
  await captureAfter(page, `owner-pending-count-approve-${sys.slot}-${requestNumber}`);
  await expect(modal).not.toBeVisible();
}
