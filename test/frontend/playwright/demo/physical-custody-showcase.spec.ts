// Demo showcase suite #3 — physical custody, three diverging assets in ONE
// request. A video-recording target like its two siblings, run via
// `pnpm run demo:e2e:physical-custody` against
// config/playwright.demo-physical-custody.config.ts (HD video, harness pacing).
//
// Narrative: a field engineer needs three physical assets for one incident
// window — a laptop, a hardware token, and a secure phone. One break-glass
// request carries all three; the approval chain routes every item into
// physical custody; then each asset walks a DIFFERENT path, showing the
// audience the full state space including the two failure branches:
//
//   * Field laptop  — the HAPPY path: prepare & handover → requester
//     confirms receipt → initiates return → agency verifies & restocks,
//     with its custody timeline fully readable at the end.
//   * Hardware token — ISSUED, THEN LOST: the requester confirms receipt of
//     it too (so the loss is genuinely on their watch — "in requester
//     custody"), then reports it missing with a narrative + evidence. The
//     exception opens; the request stays operable.
//   * Secure phone  — MISSING DURING PREPARATION: the agency custodian goes
//     to prepare it and it is not in the cabinet — checked the expected
//     location, the register, the last custodian, nearby shelves; reported
//     with evidence BEFORE it ever left the cage. The attention banner says
//     the other assets continue unaffected — and the video proves they do.
//
// The honest ending — and the reason this story is a demo worth recording:
// because the phone never crossed the requester-receipt threshold (and
// custody exceptions stay open until resolved, addendum-184 lineage), the
// request can NEVER auto-issue: the auto-issue rule requires EVERY case to
// reach requester custody (server/domains/custody.rules.tsx
// allCustodyCasesReachedRequester). So the paperwork shortcut is dead. The
// agency tries "Issue Credential" from the dashboard anyway — and the app
// REFUSES, inline, on camera: "Credential cannot be marked as issued until
// physical custody handover is complete." Custody, not the ticket status,
// is the authority. The run then closes on the outbox (the requester's
// owner-approval receipt is real mail evidence) and a console-hygiene check.
//
// Conventions match the two sibling suites (addendum-194): unified harness
// (750ms pacing, viewport-centering, captions), first-two-occurrences at
// human pace then acceleration (paceSequence), golden-pulse close-up on the
// first dashboard decision, dashboard-only navigation (addendum-178), and
// the 2FA-enrollment moment on the requester's first login.
import { test, expect } from '../harness/test';
import type { Page } from '@playwright/test';
import { E2E_USER_EMAIL, E2E_USER_PASSWORD } from '../global-setup';
import {
  login, loginPasswordOnly, completeTwoFactor, modalByTestId, pickDateTime,
  fillCredentialItemCombobox, createAssetViaAdminUI, pendingDashboardAction, openPendingDashboardRequest,
  openAdminTab,
} from '../helpers/ui';
import { provisionActorsAndTeams, provisionSystem, type ProvisionedScenario } from '../helpers/scenario';
import {
  submitWithCapture, submitRequestWithCapture, clickWithCapture, captureElement, captureGlowElement,
  captureBefore, captureAfter,
  installCaptionOverlay, demoStep, paceSequence, dwellIfSlow, actionPaceDelayMs,
} from './helpers';

const SUPERADMIN = { email: E2E_USER_EMAIL, password: E2E_USER_PASSWORD };
const SYSTEM_SHORT_CODE = 'DEMO3';
const SYSTEM_NAME = 'Custody Showcase System';

const ASSETS = [
  { hostname: 'custody-laptop-01', credential: 'Field laptop' },
  { hostname: 'custody-token-02', credential: 'Hardware token' },
  { hostname: 'custody-phone-03', credential: 'Secure phone' },
] as const;

test.describe('demo showcase #3: one request, three custody fates', () => {
  test('happy / lost-after-issue / missing-during-preparation, side by side', async ({ page, harness }) => {
    let scenario!: ProvisionedScenario;
    let requestNumber = '';

    await installCaptionOverlay(page);
    await page.goto('/');

    await demoStep(test, page, 'Setup — Actors, teams, and the custody system', async () => {
      scenario = await provisionActorsAndTeams(page, SUPERADMIN, 'custdemo', actionPaceDelayMs);
      await provisionSystem(page, scenario, { shortCode: SYSTEM_SHORT_CODE, name: SYSTEM_NAME });
    });

    await demoStep(test, page, 'Setup — Admin curates three physical assets', async () => {
      for (const [index, asset] of ASSETS.entries()) {
        const pace = paceSequence('curate-asset');
        await createAssetViaAdminUI(page, {
          systemLabel: `${SYSTEM_SHORT_CODE} — ${SYSTEM_NAME}`,
          hostname: asset.hostname,
          credentialName: asset.credential,
          credentialType: 'device',
          navigateFirst: index === 0,
        });
        await dwellIfSlow(page, pace);
      }
    });
    // With the AWS exchange unconfigured in this stack every created asset is
    // forced management-mode MANUAL (AdminAssets effectiveCreateMode), which is
    // exactly the server-side predicate that routes items into physical
    // custody (server/custody/service.tsx).

    await demoStep(test, page, 'Request — Field engineer first login, mandatory 2FA, requests all three assets', async () => {
      await loginPasswordOnly(page, scenario.vendorL1A.email, scenario.vendorL1A.password);
      await expect(page.getByTestId('two-factor-enroll')).toBeVisible();
      await expect(page.getByTestId('two-factor-enroll__qr-image')).toBeVisible();
      await captureBefore(page, 'custody-demo-2fa-enroll');
      await completeTwoFactor(page, scenario.vendorL1A.email);
      await captureAfter(page, 'custody-demo-2fa-enroll');

      const pace = paceSequence('submit-request');
      await clickWithCapture(page, 'custody-demo-open-submit', page.getByTestId('vendor-dashboard__open-submit-button'), { fast: pace.fast, delayMs: pace.delayMs });
      await page.getByTestId('vendor-dashboard__system-select')
        .selectOption({ label: `${SYSTEM_NAME} (${SYSTEM_SHORT_CODE})` });
      await page.getByTestId('vendor-dashboard__sr-number-input').fill('SR-CUSTODY-DEMO');
      await page.getByTestId('vendor-dashboard__justification-textarea')
        .fill('Field deployment: need the laptop, hardware token, and secure phone for the incident window.');
      await pickDateTime(page, page.getByTestId('vendor-dashboard__activity-start-picker'), { hour: '09', minute: '00' });
      await pickDateTime(page, page.getByTestId('vendor-dashboard__activity-end-picker'), { hour: '17', minute: '00' });
      for (const [index, asset] of ASSETS.entries()) {
        if (index > 0) await page.getByTestId('vendor-dashboard__add-credential-item-button').click();
        await fillCredentialItemCombobox(page.getByTestId('vendor-dashboard__credential-item').nth(index), asset.hostname, asset.credential);
      }
      const submitted = await submitRequestWithCapture(page, 'custody-demo-submit-request', page.getByTestId('vendor-dashboard__submit-request-button'), { fast: pace.fast, delayMs: pace.delayMs });
      requestNumber = submitted.requestNumber;
      expect(requestNumber).toBeTruthy();
      await dwellIfSlow(page, pace);
    });

    // Step-decision helper: dashboard queue only (addendum-178), golden-pulse
    // close-up while the shape is in its first two full-pace occurrences.
    // pendingDashboardAction transparently opens the row kebab (addendum-192)
    // when the action is not a direct row affordance.
    async function decideViaDashboard(
      role: 'vendor' | 'agency',
      actorEmail: string,
      actorPassword: string,
      label: string,
    ): Promise<void> {
      const pace = paceSequence('row-decide');
      await login(page, actorEmail, actorPassword);
      if (!pace.fast) await captureGlowElement(page, requestNumber, `custody-demo-golden-${label}`);
      const action = await pendingDashboardAction(page, requestNumber, `${role}-dashboard__approve-button`);
      await clickWithCapture(page, `custody-demo-decide-open-${label}`, action, { fast: pace.fast, delayMs: pace.delayMs });
      const modal = modalByTestId(page, `${role}-dashboard__action-modal`);
      await submitWithCapture(page, `custody-demo-decide-${label}`, modal.getByTestId(`${role}-dashboard__confirm-button`), { fast: pace.fast, delayMs: pace.delayMs });
      await expect(modal).not.toBeVisible();
      await dwellIfSlow(page, pace);
    }

    await demoStep(test, page, 'Request — Vendor L2 approves step 1', async () => {
      await decideViaDashboard('vendor', scenario.vendorL2A.email, scenario.vendorL2A.password, 'vl2');
    });
    await demoStep(test, page, 'Request — Agency L1 approves step 2', async () => {
      await decideViaDashboard('agency', scenario.agencyL1A.email, scenario.agencyL1A.password, 'agl1');
    });
    await demoStep(test, page, 'Request — Agency L2 approves step 3, routes to owner', async () => {
      await decideViaDashboard('agency', scenario.agencyL2A.email, scenario.agencyL2A.password, 'agl2');
    });

    await demoStep(test, page, 'Request — Owner reviews the three-track fulfillment preview, approves', async () => {
      await login(page, scenario.owner.email, scenario.owner.password);
      await openPendingDashboardRequest(page, requestNumber, 'owner-dashboard__view-button');
      const pace = paceSequence('owner-decide');
      await expect(page.getByTestId('request-detail__fulfillment-preview')).toBeVisible();
      const previewCustody = page.getByTestId('request-detail__preview-custody');
      for (const asset of ASSETS) {
        await expect(previewCustody).toContainText(asset.credential);
      }
      await captureElement(previewCustody, 'custody-demo-owner-preview');
      await clickWithCapture(page, 'custody-demo-owner-approve', page.getByTestId('request-detail-view__owner-approve-button'), { fast: pace.fast, delayMs: pace.delayMs });
      const modal = modalByTestId(page, 'request-detail-view__action-modal');
      await submitWithCapture(page, 'custody-demo-owner-confirm', modal.getByTestId('request-detail-view__confirm-button'), { fast: pace.fast, delayMs: pace.delayMs });
      await expect(modal).not.toBeVisible();
      await expect(page.getByTestId('request-custody__section')).toBeVisible();
      await expect(page.getByTestId('request-custody__case-list').getByRole('article')).toHaveCount(3);
      await expect(page.getByTestId('request-custody__summary')).toContainText('0 of 3 returned');
      await dwellIfSlow(page, pace);
    });

    function custodyCase(credential: string) {
      return page.getByTestId('request-custody__case-list').getByRole('article').filter({ hasText: credential });
    }

    // The structured problem report, exercised twice in the narrative —
    // once by the agency (missing during preparation), once by the
    // requester (lost in the field). Full pace both times: it is the star
    // interaction of this video.
    async function reportProblem(fromPage: Page, args: {
      credential: string;
      capturePrefix: string;
      description: string;
      lastKnownLocation: string;
      attachmentName: string;
      attachmentBody: string;
    }) {
      await clickWithCapture(fromPage, `${args.capturePrefix}-open`, custodyCase(args.credential).getByRole('button', { name: 'Report a problem' }));
      const modal = modalByTestId(fromPage, 'custody-problem-modal__dialog');
      await expect(modal.getByTestId('custody-problem-modal__asset')).toContainText(args.credential);
      await modal.getByTestId('custody-problem-modal__type-select').selectOption('missing');
      await modal.getByTestId('custody-problem-modal__last-location-input').fill(args.lastKnownLocation);
      await modal.getByTestId('custody-problem-modal__check-expected').check();
      await modal.getByTestId('custody-problem-modal__check-register').check();
      await modal.getByTestId('custody-problem-modal__check-custodian').check();
      await modal.getByTestId('custody-problem-modal__check-nearby').check();
      await modal.getByTestId('custody-problem-modal__description-input').fill(args.description);
      await modal.getByTestId('custody-problem-modal__attachments-input').setInputFiles([
        { name: args.attachmentName, mimeType: 'text/plain', buffer: Buffer.from(args.attachmentBody) },
      ]);
      await expect(modal.getByTestId('custody-problem-modal__attachment-list').getByRole('listitem')).toHaveCount(1);
      await clickWithCapture(fromPage, `${args.capturePrefix}-review`, modal.getByTestId('custody-problem-modal__review-button'));
      await expect(modal.getByTestId('custody-problem-modal__consequences')).toContainText('Other assets remain unchanged');
      await submitWithCapture(fromPage, `${args.capturePrefix}-confirm`, modal.getByTestId('custody-problem-modal__confirm-button'));
      await expect(modal).not.toBeVisible();
    }

    await demoStep(test, page, 'Custody — Agency custodian prepares laptop and token, phone missing from cabinet', async () => {
      await login(page, scenario.agencyL1A.email, scenario.agencyL1A.password);
      await openPendingDashboardRequest(page, requestNumber, 'agency-dashboard__view-button');
      const pace = paceSequence('custody-prep');
      for (const credential of ['Field laptop', 'Hardware token']) {
        await custodyCase(credential).getByRole('checkbox').check();
      }
      await clickWithCapture(page, 'custody-demo-prepare-handover', page.getByTestId('request-custody__batch-prepare_and_handover'), { fast: pace.fast, delayMs: pace.delayMs });
      await expect(custodyCase('Field laptop')).toContainText(/handover pending/i);
      await expect(custodyCase('Hardware token')).toContainText(/handover pending/i);
      await dwellIfSlow(page, pace);

      await reportProblem(page, {
        credential: 'Secure phone',
        capturePrefix: 'custody-demo-missing',
        description: 'Secure phone was not present in Cabinet C2 during preparation. Register last shows it returned three days ago.',
        lastKnownLocation: 'Cabinet C2, Equipment Room West',
        attachmentName: 'cabinet-c2-check.txt',
        attachmentBody: 'Cabinet C2 photographed empty; shelf tag intact.',
      });
      await expect(page.getByTestId('request-custody__attention-warning')).toContainText('unaffected assets may continue');
      await expect(custodyCase('Secure phone')).toContainText(/cannot locate/i);
      await expect(custodyCase('Secure phone')).toContainText('1 attachment');
      // The other two cases are untouched by the exception.
      await expect(custodyCase('Field laptop')).toContainText(/handover pending/i);
    });

    await demoStep(test, page, 'Custody — Field engineer takes delivery, open exception blocks auto-issue', async () => {
      await login(page, scenario.vendorL1A.email, scenario.vendorL1A.password);
      await openPendingDashboardRequest(page, requestNumber, 'vendor-dashboard__view-button');
      const pace = paceSequence('custody-receipt');
      await clickWithCapture(page, 'custody-demo-receipt-laptop', custodyCase('Field laptop').getByRole('button', { name: 'Confirm receipt' }), { fast: pace.fast, delayMs: pace.delayMs });
      await expect(custodyCase('Field laptop')).toContainText(/requester custody/i);
      await clickWithCapture(page, 'custody-demo-receipt-token', custodyCase('Hardware token').getByRole('button', { name: 'Confirm receipt' }), { fast: pace.fast, delayMs: pace.delayMs });
      await expect(custodyCase('Hardware token')).toContainText(/requester custody/i);
      // The teaching moment: auto-issue requires EVERY custody case to reach
      // requester custody (custody.rules.tsx allCustodyCasesReachedRequester).
      // The phone case is exception_open from awaiting_preparation — it never
      // crossed the threshold — so both receipt confirmations leave the
      // request at 'approved', with the exceptions counter holding at one.
      await expect(page.getByTestId('request-custody__summary')).toContainText('0 of 3 returned');
      await expect(page.getByTestId('request-custody__summary')).toContainText('1 exception');
      await expect(custodyCase('Secure phone')).toContainText(/cannot locate/i);
      await dwellIfSlow(page, pace);
    });

    await demoStep(test, page, 'Custody — Laptop return begins, hardware token reported lost', async () => {
      await clickWithCapture(page, 'custody-demo-initiate-return', custodyCase('Field laptop').getByRole('button', { name: 'Initiate return' }));
      await expect(custodyCase('Field laptop')).toContainText(/return pending/i);

      await reportProblem(page, {
        credential: 'Hardware token',
        capturePrefix: 'custody-demo-lost',
        description: 'Hardware token was lost during the offsite visit — bag tampered between the site and the office. Reported at once.',
        lastKnownLocation: 'Customer site loading bay',
        attachmentName: 'loss-statement.txt',
        attachmentBody: 'Signed loss statement filed with site security at 16:40.',
      });
      await expect(custodyCase('Hardware token')).toContainText(/cannot locate/i);
      await expect(page.getByTestId('request-custody__attention-warning')).toBeVisible();
      await expect(page.getByTestId('request-custody__summary')).toContainText('2 exceptions');
    });

    await demoStep(test, page, 'Custody — Agency verifies laptop return, restores inventory', async () => {
      await login(page, scenario.agencyL1A.email, scenario.agencyL1A.password);
      await openPendingDashboardRequest(page, requestNumber, 'agency-dashboard__view-button');
      await custodyCase('Field laptop').getByRole('checkbox').check();
      await clickWithCapture(page, 'custody-demo-verify-restock', page.getByTestId('request-custody__batch-verify_and_restock'));
      await expect(page.getByTestId('request-custody__summary')).toContainText('1 of 3 returned');
      await expect(page.getByTestId('request-custody__summary')).toContainText('2 exceptions');
    });

    await demoStep(test, page, 'Custody — Agency\'s paperwork shortcut refused, on camera', async () => {
      // Close is impossible too (close requires credential_issued), so the
      // ONLY dash-move the ticket sideways is "Mark issued" — and the
      // backend's custody 409 guard (server/routes/requests/delivery.tsx)
      // is what the audience sees refuse it. The dashboard row offers the
      // action; the modal stays open with the guard text on failure.
      const backButton = page.getByTestId('request-detail-view__back-button');
      await clickWithCapture(page, 'custody-demo-back-to-queue', backButton);
      const issueAction = await pendingDashboardAction(page, requestNumber, 'agency-dashboard__issue-button');
      await clickWithCapture(page, 'custody-demo-issue-open', issueAction);
      const modal = modalByTestId(page, 'agency-dashboard__action-modal');
      await submitWithCapture(page, 'custody-demo-issue-refused', modal.getByTestId('agency-dashboard__confirm-button'));
      await expect(modal.getByText(/physical custody handover is complete/i)).toBeVisible();
      await captureElement(modal, 'custody-demo-issue-refused-alert');
      await clickWithCapture(page, 'custody-demo-issue-cancel', modal.getByTestId('agency-dashboard__cancel-button'));
      await expect(modal).not.toBeVisible();
    });

    await demoStep(test, page, 'Custody — Exception records and laptop timeline remain investigable', async () => {
      await openPendingDashboardRequest(page, requestNumber, 'agency-dashboard__view-button');
      await expect(custodyCase('Secure phone')).toContainText(/cannot locate/i);
      await expect(custodyCase('Hardware token')).toContainText(/cannot locate/i);
      // History starts expanded for every case on mount (useRequestAssetCustody.ts)
      // — the request detail view shows everything by default, so "Hide
      // history" is already showing here. Collapse then re-open so the demo
      // still visibly performs the reveal on camera, rather than clicking a
      // "View history" button that doesn't exist in this default state.
      await clickWithCapture(page, 'custody-demo-history-collapse', custodyCase('Field laptop').getByRole('button', { name: 'Hide history' }));
      await clickWithCapture(page, 'custody-demo-history-happy', custodyCase('Field laptop').getByRole('button', { name: 'View history' }));
      await expect(custodyCase('Field laptop')).toContainText(/return/i);
      await captureElement(page.getByTestId('request-custody__section'), 'custody-demo-final-ledger');
    });

    await demoStep(test, page, 'Notifications — Admin tours the outbox, owner-approval receipt reached the requester', async () => {
      await login(page, SUPERADMIN.email, SUPERADMIN.password);
      await openAdminTab(page, 'sent-notifications', 'admin-sent-notifications__table');
      const approvalRow = page.getByTestId('admin-sent-notifications__row')
        .filter({ hasText: 'request.owner_approved_submitter' }).first();
      await expect(approvalRow).toBeVisible();
      await expect(approvalRow.getByTestId('admin-sent-notifications__recipients-cell'))
        .toContainText(scenario.vendorL1A.email);
      await clickWithCapture(page, 'custody-demo-outbox-detail', approvalRow);
      const detail = modalByTestId(page, 'admin-sent-notifications__detail-modal');
      await expect(detail).toBeVisible();
      await expect(detail).toContainText(requestNumber);
      await clickWithCapture(page, 'custody-demo-outbox-close', detail.getByTestId('admin-sent-notifications__detail-close-button'));
      await expect(detail).not.toBeVisible();
    });

    await demoStep(test, page, 'Wrap-up — Ending cold, no console warnings', async () => {
      const noisy = harness.consoleLog()
        .filter((e) => e.type === 'error' || e.type === 'pageerror')
        .filter((e) => /unique "key" prop|not wrapped in act|Each child in a list|validateDOMNesting/i.test(e.text));
      expect(noisy, `console hygiene violations on camera: ${noisy.map((e) => e.text).join(' | ')}`).toEqual([]);
    });
  });
});
