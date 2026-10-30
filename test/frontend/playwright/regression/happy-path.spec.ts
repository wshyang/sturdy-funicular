// Full multi-actor happy-path scenario: superadmin bootstraps signups (2
// members per level x 4 levels + 1 owner = 9 actors), builds out
// clusters/teams/a system/workflow/mappings/memberships, and a vendor L1
// engineer submits a break-glass request that is carried through its full
// lifecycle by the corrected 3-step approval chain:
//   vendor L1 (submits) -> vendor L2 -> agency L1 -> agency L2 -> owner
//     -> agency L1 issues credential -> agency L1 closes
//
// At every stage transition this asserts the FULL visibility matrix — the
// currently-active step's team (BOTH members) can see/act on the request,
// and every other actor (both members of every other team, the owner
// pre-terminal, the non-submitting vendor L1 teammate) cannot — including a
// direct backend GET returning 404 for a representative "shouldn't see it"
// actor at each stage, proving the BACKEND enforces this (per
// addendum-013-step-scoped-request-visibility-fix.md), not merely that the
// dashboard UI happens to omit a row.
//
// Every interaction (not just form submissions) gets before/after capture:
// viewing a dashboard, the row-level action-trigger click that opens a
// modal, and the modal's confirm click — two before/after pairs per action.
import { test, expect } from '../helpers/harness';
import { E2E_USER_EMAIL, E2E_USER_PASSWORD } from '../global-setup';
import {
  login, modalByTestId, pickDateTime, submitWithCapture,
  submitRequestIdentityWithCapture, clickWithCapture, assertRequestVisible,
  assertRequestNotVisible, directGetRequestStatus, createAssetViaAdminUI, fillCredentialItemCombobox,
  pendingDashboardAction, openPendingDashboardRequest,
  clickCustodyActionAndWait,
} from '../helpers/ui';
import { provisionActorsAndTeams, provisionSystem, type ProvisionedScenario, type Actor } from '../helpers/scenario';

const SUPERADMIN = { email: E2E_USER_EMAIL, password: E2E_USER_PASSWORD };
const SYSTEM_SHORT_CODE = 'HPSYS';
const SYSTEM_NAME = 'Happy Path Test System';
const SR_NUMBER = 'SR-HAPPY001';
const ASSET_HOSTNAME = 'vault.prod.internal';
const ASSET_CREDENTIAL_NAME = 'tok-emergency-001';

test.describe('multi-actor happy-path request lifecycle', () => {
  test('signup -> admin setup -> full request lifecycle with visibility matrix', async ({ page }) => {
    let scenario!: ProvisionedScenario;
    let requestId = '';
    let requestNumber = '';

    await test.step('provision 9 actors, 2 clusters, 4 teams, and the system (3-step workflow)', async () => {
      scenario = await provisionActorsAndTeams(page, SUPERADMIN, 'hp');
      await provisionSystem(page, scenario, { shortCode: SYSTEM_SHORT_CODE, name: SYSTEM_NAME });
      // Per addendum-039-asset-gated-submission.md.
      await createAssetViaAdminUI(page, {
        systemLabel: `${SYSTEM_SHORT_CODE} — ${SYSTEM_NAME}`, hostname: ASSET_HOSTNAME, credentialName: ASSET_CREDENTIAL_NAME,
        credentialType: 'token', navigateFirst: true,
      });
    });

    // Logs in as `actor`, asserts the request is NOT in their dashboard list,
    // and (for exactly one representative actor per stage, passed via
    // `checkBackend`) asserts the direct-GET backend path also 404s —
    // proving backend, not just UI, enforcement.
    async function assertNotVisibleFor(actor: Actor, opts: { checkBackend?: boolean } = {}) {
      await login(page, actor.email, actor.password);
      await assertRequestNotVisible(page, SYSTEM_NAME);
      if (opts.checkBackend) {
        const status = await directGetRequestStatus(page, requestId);
        expect(status).toBe(404);
      }
    }

    // ── Stage 0: vendor L1 A submits ──────────────────────────────────────
    await test.step('vendor L1 A submits a request', async () => {
      await login(page, scenario.vendorL1A.email, scenario.vendorL1A.password);
      await clickWithCapture(page, 'happy-path-view-dashboard-before-submit', page.getByTestId('vendor-dashboard__open-submit-button'));
      await page.getByTestId('vendor-dashboard__system-select')
        .selectOption({ label: `${SYSTEM_NAME} (${SYSTEM_SHORT_CODE})` });
      await page.getByTestId('vendor-dashboard__sr-number-input').fill(SR_NUMBER);
      await page.getByTestId('vendor-dashboard__justification-textarea')
        .fill('Production incident requiring emergency database access.');
      await pickDateTime(page, page.getByTestId('vendor-dashboard__activity-start-picker'), { hour: '09', minute: '00' });
      await pickDateTime(page, page.getByTestId('vendor-dashboard__activity-end-picker'), { hour: '17', minute: '00' });
      await fillCredentialItemCombobox(page.getByTestId('vendor-dashboard__credential-item'), ASSET_HOSTNAME, ASSET_CREDENTIAL_NAME);
      const submitted = await submitRequestIdentityWithCapture(page, 'happy-path-submit-request', page.getByTestId('vendor-dashboard__submit-request-button'));
      requestId = submitted.id;
      requestNumber = submitted.requestNumber;
      await assertRequestVisible(page, requestNumber);
    });

    // ── Stage 0 visibility: only vendor L2 (both members) can act; everyone
    // else — including the submitter's own L1 teammate — cannot see it yet ──
    await test.step('visibility after submit: only vendor L2 team sees it', async () => {
      for (const notYet of [scenario.vendorL1B, scenario.agencyL1A, scenario.agencyL1B, scenario.agencyL2A, scenario.agencyL2B, scenario.owner]) {
        await assertNotVisibleFor(notYet, { checkBackend: notYet === scenario.owner });
      }
      for (const active of [scenario.vendorL2A, scenario.vendorL2B]) {
        await login(page, active.email, active.password);
        await assertRequestVisible(page, SYSTEM_NAME);
      }
    });

    // ── Stage 1: vendor L2 A receives the request in their pending dashboard. ─
    await test.step('vendor L2 A sees the assigned request ready in the dashboard and approves step 1', async () => {
      await login(page, scenario.vendorL2A.email, scenario.vendorL2A.password);
      const approve = await pendingDashboardAction(page, requestNumber, 'vendor-dashboard__approve-button');
      await clickWithCapture(page, 'happy-path-vendor-l2-open-approve-modal', approve);
      const modal = modalByTestId(page, 'vendor-dashboard__action-modal');
      await submitWithCapture(page, 'happy-path-vendor-l2-approve', modal.getByTestId('vendor-dashboard__confirm-button'));
      await expect(modal).not.toBeVisible();
    });

    // ── Stage 1 dashboard visibility: request moves to agency L1. Vendor L2
    // (both — their own step already passed) must LOSE dashboard visibility;
    // agency L1 gains it. Vendor L1 A (the submitter) always retains
    // visibility regardless of step — the audit-trail self-view exception
    // in canViewRequest — so it's excluded from the negative set and
    // checked separately. Owner still fully blocked (Constraint #11,
    // unaffected by addendum-028) — checked via direct GET here. ──────────
    await test.step('dashboard visibility after vendor L2 approves: only agency L1 team (and the submitter) sees it', async () => {
      for (const notNow of [scenario.vendorL1B, scenario.vendorL2A, scenario.vendorL2B, scenario.agencyL2A, scenario.agencyL2B, scenario.owner]) {
        await assertNotVisibleFor(notNow, { checkBackend: notNow === scenario.owner });
      }
      for (const active of [scenario.agencyL1A, scenario.agencyL1B, scenario.vendorL1A]) {
        await login(page, active.email, active.password);
        await assertRequestVisible(page, SYSTEM_NAME);
      }
    });

    // ── Per addendum-028-visibility-fix-and-emergency-override.md: search/
    // view is now SYSTEM-scoped while pre-owner, not step-scoped — agency L2
    // (a downstream reviewer, their own step is ordinal 4, later than the
    // current ordinal 2) can already find/view this request via direct GET,
    // even though it's correctly absent from their dashboard (checked
    // above) and they cannot yet act on it without the emergency override. ─
    await test.step('agency L2 can already view (but not act on) the request via direct GET — system-scoped, addendum-028', async () => {
      await login(page, scenario.agencyL2A.email, scenario.agencyL2A.password);
      const status = await directGetRequestStatus(page, requestId);
      expect(status).toBe(200);
    });

    // ── Stage 2: agency L1 A approves ─────────────────────────────────────
    await test.step('agency L1 A approves step 2', async () => {
      await login(page, scenario.agencyL1A.email, scenario.agencyL1A.password);
      await clickWithCapture(page, 'happy-path-agency-l1-open-approve-modal', await pendingDashboardAction(page, requestNumber, 'agency-dashboard__approve-button'));
      const modal = modalByTestId(page, 'agency-dashboard__action-modal');
      await submitWithCapture(page, 'happy-path-agency-l1-approve', modal.getByTestId('agency-dashboard__confirm-button'));
      await expect(modal).not.toBeVisible();
    });

    // ── Stage 2 visibility: request moves to agency L2. Agency L1 loses it,
    // agency L2 gains it, owner STILL cannot see it (ordinal is 2, not yet
    // terminal). Vendor L1 A (submitter) always retains visibility. ────────
    await test.step('visibility after agency L1 approves: only agency L2 team (and the submitter) sees it', async () => {
      for (const notNow of [scenario.vendorL1B, scenario.vendorL2A, scenario.vendorL2B, scenario.agencyL1A, scenario.agencyL1B, scenario.owner]) {
        await assertNotVisibleFor(notNow, { checkBackend: notNow === scenario.owner });
      }
      for (const active of [scenario.agencyL2A, scenario.agencyL2B, scenario.vendorL1A]) {
        await login(page, active.email, active.password);
        await assertRequestVisible(page, SYSTEM_NAME);
      }
    });

    // ── Stage 3: agency L2 A approves (routes to owner terminal) ──────────
    await test.step('agency L2 A approves step 3 (final step, routes to owner)', async () => {
      await login(page, scenario.agencyL2A.email, scenario.agencyL2A.password);
      await clickWithCapture(page, 'happy-path-agency-l2-open-approve-modal', await pendingDashboardAction(page, requestNumber, 'agency-dashboard__approve-button'));
      const modal = modalByTestId(page, 'agency-dashboard__action-modal');
      await submitWithCapture(page, 'happy-path-agency-l2-approve', modal.getByTestId('agency-dashboard__confirm-button'));
      await expect(modal).not.toBeVisible();
    });

    // ── Stage 3 visibility: current_step_ordinal is now 0 — by definition
    // (Constraint #11 / isPreOwner in auth.tsx) the request has ALREADY left
    // the pre-owner window the instant the final step is approved, before
    // the owner has even acted. Step-scoping only applies WHILE preOwner is
    // true, so this is exactly where addendum-013's deliberately-unchanged
    // broad "anyone with a historical role on this system" visibility kicks
    // back in for EVERY team mapped to the system — not just past reviewers,
    // but vendor L1 too (submitter-tier team members are part of
    // visible_system_ids via submitter_system_ids, same as reviewers via
    // reviewer_system_ids). This is real backend behavior, not a gap: once a
    // request is fully decided (or, as here, awaiting only the owner), the
    // broad model is a deliberate scope boundary (addendum-013), not
    // step-scoped at all. Every one of this system's 9 actors can see it. ──
    await test.step('visibility once ordinal reaches 0 (owner terminal): broad historical-role visibility restored for every team on this system, before the owner even decides', async () => {
      for (const nowVisible of [
        scenario.vendorL1A, scenario.vendorL1B, scenario.vendorL2A, scenario.vendorL2B,
        scenario.agencyL1A, scenario.agencyL1B, scenario.agencyL2A, scenario.agencyL2B, scenario.owner,
      ]) {
        await login(page, nowVisible.email, nowVisible.password);
        await assertRequestVisible(page, SYSTEM_NAME);
      }
    });

    // ── Stage 4: owner approves ───────────────────────────────────────────
    await test.step('system owner approves (owner terminal decision)', async () => {
      await login(page, scenario.owner.email, scenario.owner.password);
      await clickWithCapture(page, 'happy-path-owner-open-approve-modal', await pendingDashboardAction(page, requestNumber, 'owner-dashboard__approve-button'));
      const modal = modalByTestId(page, 'owner-dashboard__action-modal');
      await submitWithCapture(page, 'happy-path-owner-approve', modal.getByTestId('owner-dashboard__confirm-button'));
      await expect(modal).not.toBeVisible();
    });

    // ── Post-decision visibility restore: request has left preOwner
    // (status=approved) — broad historical-role visibility is deliberately
    // restored (addendum-013), so every past reviewer team can see it again ─
    await test.step('visibility after owner approves: broad historical-role visibility restored', async () => {
      for (const pastReviewer of [scenario.vendorL2A, scenario.agencyL1A, scenario.agencyL2A]) {
        await login(page, pastReviewer.email, pastReviewer.password);
        await assertRequestVisible(page, SYSTEM_NAME);
      }
    });

    // ── Stage 4.5: physical custody prerequisite — addendum-164 routes all ──
    // items to custody when AWS integration is off (the test environment).   ──
    // All cases must reach requester custody before issuance is unblocked.   ──
    await test.step('agency L1 A hands over asset; vendor L1 A confirms receipt (custody prerequisite)', async () => {
      await login(page, scenario.agencyL1A.email, scenario.agencyL1A.password);
      await openPendingDashboardRequest(page, requestNumber, 'agency-dashboard__view-button');
      await expect(page.getByTestId('request-custody__section')).toBeVisible();
      const assetCase = page.getByTestId('request-custody__case-list')
        .getByRole('article')
        .filter({ hasText: ASSET_CREDENTIAL_NAME });
      await assetCase.getByRole('checkbox').check();
      await page.getByTestId('request-custody__batch-prepare_and_handover').click();
      // Server-reconciled wait: the batch bar unmounts only after the POST
      // succeeds (selection clears on success, not on the optimistic
      // projection). Without this the next page navigation can abort the
      // in-flight POST and the asserted state is only client-side projection.
      await expect(page.getByTestId('request-custody__batch-bar')).toBeHidden();
      await expect(assetCase).toContainText(/handover pending/i);

      await login(page, scenario.vendorL1A.email, scenario.vendorL1A.password);
      await openPendingDashboardRequest(page, requestNumber, 'vendor-dashboard__view-button');
      await clickCustodyActionAndWait(page, assetCase.getByRole('button', { name: 'Confirm receipt' }));
      await expect(assetCase).toContainText(/requester custody/i);
    });

    // ── Stage 5: custody auto-issued credential; agency L1 closes ────────
    // After all custody cases reach requester custody the server auto-issues
    // (shouldAutoIssueCustodyRequest / custody/service.tsx). The manual issue
    // step is therefore gone; agency L1 B only needs to close.
    await test.step('agency L1 B closes auto-issued request', async () => {
      await login(page, scenario.agencyL1B.email, scenario.agencyL1B.password);
      await clickWithCapture(page, 'happy-path-close-open-modal', await pendingDashboardAction(page, requestNumber, 'agency-dashboard__close-button'));
      const closeModal = modalByTestId(page, 'agency-dashboard__action-modal');
      await submitWithCapture(page, 'happy-path-close-request', closeModal.getByTestId('agency-dashboard__confirm-button'));
      await expect(closeModal).not.toBeVisible();
    });

    // ── Final state check via vendor L1 A's own request list ─────────────
    await test.step('vendor L1 A sees the request closed', async () => {
      await login(page, scenario.vendorL1A.email, scenario.vendorL1A.password);
      const row = page.locator('tr', { hasText: requestNumber });
      await expect(row).toContainText(/closed/i);

      await clickWithCapture(page, 'happy-path-view-closed-detail', row.getByTestId('vendor-dashboard__view-button'), { waitForLocator: page.getByTestId('request-detail-view__back-button') });
      await expect(page.getByTestId('request-detail-view__credential-type-badge')).toHaveText('token');

      // addendum-017-http-access-logging.md: the "Request Submitted" audit
      // event was produced by this actor's own real HTTP POST /requests
      // call earlier in the scenario, so it carries a linked access_log row
      // — click through to it and confirm the popup shows real request
      // metadata, not a mock. Opening the modal is a pure client-side state
      // flip (no network round trip), so clickWithCapture waits on the modal
      // locator itself rather than networkidle.
      // The audit timeline disclosure is OPEN by default (RequestDetailView
      // renders <details open>, pinned by RequestDetailView.coverage.test.tsx
      // and the demo suites) — the access-log links are visible immediately.
      await expect(page.getByTestId('request-detail-view__audit-disclosure')).toHaveAttribute('open', '');
      const accessLogModal = modalByTestId(page, 'request-detail-view__access-log-modal');
      await clickWithCapture(
        page, 'happy-path-view-access-log',
        page.getByTestId('request-detail-view__access-log-link').first(),
        { waitForLocator: accessLogModal },
      );
      await expect(accessLogModal).toContainText('POST');
      await accessLogModal.getByTestId('request-detail-view__access-log-modal__close-button').click();
      await expect(accessLogModal).not.toBeVisible();
    });
  });
});
