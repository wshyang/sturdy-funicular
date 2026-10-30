// Demo showcase suite — a SEPARATE video-recording target from the
// regression e2e suite (test/frontend/playwright/.spec.ts, run via `pnpm run test:e2e`), run
// instead via `pnpm run demo:e2e` against config/playwright.demo.config.ts (HD
// video, slowMo). See
// docs/specs/addenda/addendum-022-demo-showcase-e2e-suite.md.
//
// Narrative: the same actor/team/system provisioning and 3-step approval
// chain as happy-path.spec.ts (vendor L1 submits -> vendor L2 -> agency L1
// -> agency L2 -> owner terminal -> physical custody handover -> requester
// receipt auto-issues -> close independently -> return and restock), WITHOUT the
// regression suite's visibility-matrix assertions (those are correctness
// checks, not demo-relevant) — followed by a system-owner feature showcase
// (Statistics tab, My Systems tab) and a full delegate lifecycle: the
// requester raises THREE separate requests (request #1 walks the full
// lifecycle solo, to closed, exactly as before); requests #2 and #3 are
// carried up to — but not past — the owner-terminal decision and left
// pending. The owner then assigns a delegate, the delegate logs in and
// approves ONE of the two pending requests, the owner revokes the
// delegation, and the (now former) delegate logs in again to show they see
// no requests at all and cannot find the still-pending request via Search
// either — demonstrating that delegate access is revoked immediately and
// without any existence disclosure, per addendum-028's no-existence-
// disclosure convention already exercised elsewhere in this suite.
//
// The delegate is a fresh, team-less actor (not one of the 8 workflow-role
// actors from provisionActorsAndTeams) — using e.g. agencyL1B would give
// them a conflicting real reviewer role on the same system's approval
// chain, muddying the "pure delegate" story this narrative is telling.
//
// Pacing: with 3 requests each walking a multi-step approval chain, several
// interaction SHAPES (submit a request; approve via a dashboard row button)
// repeat many times over. Per explicit request, each shape plays at full,
// screenshotted, human pace (750ms pre-action delay + before/after captures
// + a brief post-action dwell) for its first TWO occurrences, then
// automatically accelerates (the screenshot pair and dwell drop away) from
// the third occurrence of that SAME shape onward — see
// ../demo/helpers/index.ts's paceSequence/dwellIfSlow. This keeps the video
// teaching every distinct interaction at a watchable pace without re-showing
// an already-established shape a fourth or fifth time at full length.
//
// Addendum-194 refresh: the suite now runs on the UNIFIED harness
// (../harness/test.ts — pacing + viewport-centering + captions on top of the
// observable harness), every action is center-framed in the viewport before
// it fires, and the recording picks up the feature beats the app has grown
// since this video was first cut:
//   * a deliberate first-login two-factor ENROLLMENT moment (capture the QR
//     gate before completing it — security is not optional);
//   * the golden-pulse "this row awaits MY decision" status badge, captured
//     in close-up before each of the first two dashboard decisions;
//   * a keyboard-accessibility beat (skip-to-content link -> #main-content);
//   * the multichannel notification OUTBOX tour (approval notifications
//     staged + receipt-tracked, visible even with real delivery disabled);
//   * a closing console-hygiene assertion (no React key/act warnings on
//     camera), plus lucide-icon action bar / danger-zone captions.
import { test, expect } from '../harness/test';
import { E2E_USER_EMAIL, E2E_USER_PASSWORD } from '../global-setup';
import { login, loginPasswordOnly, completeTwoFactor, modalByTestId, pickDateTime, fillCredentialItemCombobox, signup, approveUser, createAssetViaAdminUI, pendingDashboardAction, openPendingDashboardRequest, openAdminTab } from '../helpers/ui';
import { provisionActorsAndTeams, provisionSystem, type ProvisionedScenario } from '../helpers/scenario';
import {
  submitWithCapture, submitRequestWithCapture, clickWithCapture, captureElement, captureGlowElement,
  captureBefore, captureAfter,
  installCaptionOverlay, demoStep, paceSequence, dwellIfSlow, actionPaceDelayMs,
} from './helpers';

const SUPERADMIN = { email: E2E_USER_EMAIL, password: E2E_USER_PASSWORD };
const SYSTEM_SHORT_CODE = 'DEMO1';
const SYSTEM_NAME = 'Demo Showcase System';

const DELEGATE = {
  fullName: 'Demo Delegate Reviewer',
  email: 'demo-delegate.demo1@test.local',
  password: 'DemoDelegatePass!2026demo1',
};

test.describe('demo showcase: custody-backed lifecycle + owner feature tour', () => {
  test('approval preview, custody handover/return, statistics, systems, and delegate revocation', async ({ page, harness }) => {
    let scenario!: ProvisionedScenario;
    let request1Number = '';
    let request2Number = '';
    let request3Number = '';

    // Registers the on-screen caption overlay BEFORE any navigation — every
    // demoStep() call below updates its text, and it survives every login()
    // reload for the rest of the run. See ../demo/helpers/index.ts. An initial
    // goto is needed before the FIRST setCaption call: the page starts on
    // about:blank, where localStorage access throws, so that first caption
    // would otherwise be silently dropped.
    await installCaptionOverlay(page);
    await page.goto('/');

    await demoStep(test, page, 'Setup — Actors, teams, and the demo system', async () => {
      // 9 signups + 9 approvals is the single most repetitive stretch in this
      // whole video — pace the first two of EACH loop at human speed (via
      // actionPaceDelayMs, keyed by provisionActorsAndTeams()'s own per-loop
      // index) and the rest with zero added delay, exactly like every other
      // repeated shape in this spec.
      scenario = await provisionActorsAndTeams(page, SUPERADMIN, 'demo', actionPaceDelayMs);
      await provisionSystem(page, scenario, {
        shortCode: SYSTEM_SHORT_CODE,
        name: SYSTEM_NAME,
        // The system declares an exchange capability, while this config keeps
        // AWS_INTEGRATION_ENABLED off. API-managed assets therefore remain
        // declared API-managed but route through custody at approval time.
        awsRoleArnNote: 'arn:aws:iam::123456789012:role/demo-custody-fallback',
      });
    });

    // Feature the new Assets admin tab during setup, before any request is
    // ever submitted — curates the three (hostname, credential_name) pairs
    // the vendor is about to request below, one per request, so each
    // submission visibly matches a known, verified asset rather than an
    // arbitrary free-text guess.
    await demoStep(test, page, "Curating API-managed assets; AWS lockdown will route them through custody", async () => {
      await clickWithCapture(page, 'demo-open-assets-tab', page.getByTestId('admin-panel__tab-assets'));
      await page.getByTestId('admin-assets__system-select')
        .selectOption({ label: `${SYSTEM_SHORT_CODE} — ${SYSTEM_NAME}` });
      await clickWithCapture(page, 'demo-assets-open-create-form', page.getByTestId('admin-assets__toggle-create-form-button'));
      await page.getByTestId('admin-assets__create-hostname-input').fill('vault.prod.internal');
      await page.getByTestId('admin-assets__create-credential-name-input').fill('tok-emergency-001');
      await page.getByTestId('admin-assets__create-credential-type-select').selectOption('token');
      await expect(page.getByTestId('admin-assets__management-mode-select')).toHaveValue('api_managed');
      await expect(page.getByTestId('admin-assets__management-mode-blocked-note')).toHaveCount(0);
      await submitWithCapture(page, 'demo-assets-add-asset', page.getByTestId('admin-assets__create-submit-button'));
      await expect(page.getByTestId('admin-assets__row')).toBeVisible();

      // Two more assets for requests #2 and #3, added without re-capturing
      // every field (already demonstrated above) — the create form's own
      // before/after screenshot still lands per addAsset call.
      await createAssetViaAdminUI(page, { systemLabel: `${SYSTEM_SHORT_CODE} — ${SYSTEM_NAME}`, hostname: 'vault.staging.internal', credentialName: 'tok-emergency-002', credentialType: 'token' });
      await createAssetViaAdminUI(page, { systemLabel: `${SYSTEM_SHORT_CODE} — ${SYSTEM_NAME}`, hostname: 'vault.dr.internal', credentialName: 'tok-emergency-003', credentialType: 'token' });
    });

    // ── Shared, pacing-aware building blocks ──────────────────────────────
    // Every repeated interaction shape below funnels through one of these
    // three helpers, each keyed by its own `kind` string — paceSequence()
    // tracks occurrence counts PER kind, so "submit a request" accelerating
    // after its 2nd play is independent of pending-dashboard approval doing the
    // same after ITS 2nd play.

    async function submitRequestAsVendor(
      srNumber: string, hostname: string, credentialName: string, label: string,
      opts: { alreadyLoggedIn?: boolean } = {},
    ): Promise<string> {
      const pace = paceSequence('submit-request');
      // Request #1's video beat logs the vendor in ITSELF first (capturing
      // the mandatory first-login 2FA enrollment gate as its own feature
      // moment) — later requests use the plain login here.
      if (!opts.alreadyLoggedIn) {
        await login(page, scenario.vendorL1A.email, scenario.vendorL1A.password);
      }
      await clickWithCapture(page, `demo-view-dashboard-before-submit-${label}`, page.getByTestId('vendor-dashboard__open-submit-button'), { fast: pace.fast, delayMs: pace.delayMs });
      await page.getByTestId('vendor-dashboard__system-select')
        .selectOption({ label: `${SYSTEM_NAME} (${SYSTEM_SHORT_CODE})` });
      await page.getByTestId('vendor-dashboard__sr-number-input').fill(srNumber);
      await page.getByTestId('vendor-dashboard__justification-textarea')
        .fill(`Production incident requiring emergency database access (request ${label}).`);
      await pickDateTime(page, page.getByTestId('vendor-dashboard__activity-start-picker'), { hour: '09', minute: '00' });
      await pickDateTime(page, page.getByTestId('vendor-dashboard__activity-end-picker'), { hour: '17', minute: '00' });
      await fillCredentialItemCombobox(page.getByTestId('vendor-dashboard__credential-item'), hostname, credentialName);
      const { id: requestId, requestNumber } = await submitRequestWithCapture(page, `demo-submit-request-${label}`, page.getByTestId('vendor-dashboard__submit-request-button'), { fast: pace.fast, delayMs: pace.delayMs });
      expect(requestId).toBeTruthy();
      await dwellIfSlow(page, pace);
      return requestNumber;
    }

    async function decideViaDashboard(
      requestNumber: string,
      role: 'vendor' | 'agency' | 'owner' | 'delegate',
      label: string,
    ): Promise<void> {
      const pace = paceSequence('row-decide');
      const prefix = role === 'delegate' ? 'delegate-approval-panel' : `${role}-dashboard`;
      const actionTestId = `${prefix}__approve-button`;
      // While this shape is still playing at full human pace, capture the
      // golden-pulse badge in close-up first — the status pill announcing
      // "this row awaits MY decision" (step-scoped actionability) is the
      // visual hook the viewer should feel before the approve click lands.
      if (!pace.fast) {
        await captureGlowElement(page, requestNumber, `demo-golden-row-${label}`);
      }
      const action = await pendingDashboardAction(page, requestNumber, actionTestId);
      await clickWithCapture(page, `demo-row-decide-open-${label}`, action, { fast: pace.fast, delayMs: pace.delayMs });
      const modal = modalByTestId(page, `${prefix}__action-modal`);
      await submitWithCapture(page, `demo-row-decide-${label}`, modal.getByTestId(`${prefix}__confirm-button`), { fast: pace.fast, delayMs: pace.delayMs });
      await expect(modal).not.toBeVisible();
      await dwellIfSlow(page, pace);
    }

    // ── Request #1: full solo lifecycle, exactly as before — submit through
    // to closed, with the access-log tour — before the other two requests
    // exist, so there is never any row ambiguity during this stretch. ──────

    await demoStep(test, page, 'Request #1 — Vendor L1 first login, mandatory 2FA enrollment, submits break-glass request', async () => {
      // First-ever login for this actor: password accepted, then the 2FA
      // ENROLL gate is mandatory before any dashboard is reachable
      // (addendum-046/047). Capture the QR enrol modal as its own feature
      // moment — the video should make "security is not optional" visible —
      // then complete enrollment and land on the dashboard.
      await loginPasswordOnly(page, scenario.vendorL1A.email, scenario.vendorL1A.password);
      await expect(page.getByTestId('two-factor-enroll')).toBeVisible();
      await expect(page.getByTestId('two-factor-enroll__qr-image')).toBeVisible();
      await captureBefore(page, 'demo-2fa-enroll');
      await completeTwoFactor(page, scenario.vendorL1A.email);
      await captureAfter(page, 'demo-2fa-enroll');

      request1Number = await submitRequestAsVendor('SR-DEMO001', 'vault.prod.internal', 'tok-emergency-001', '1', { alreadyLoggedIn: true });
    });

    await demoStep(test, page, 'Request #1 — Vendor L2 approves step 1', async () => {
      await login(page, scenario.vendorL2A.email, scenario.vendorL2A.password);
      await decideViaDashboard(request1Number, 'vendor', '1-vl2');
    });

    await demoStep(test, page, 'Request #1 — Agency L1 approves step 2', async () => {
      await login(page, scenario.agencyL1A.email, scenario.agencyL1A.password);
      await decideViaDashboard(request1Number, 'agency', '1-agl1');
    });

    await demoStep(test, page, 'Request #1 — Agency L2 approves step 3, routes to owner', async () => {
      await login(page, scenario.agencyL2A.email, scenario.agencyL2A.password);
      await decideViaDashboard(request1Number, 'agency', '1-agl2');
    });

    // Feature the multichannel notification outbox: every workflow decision
    // stages a normalized notification with per-recipient, per-channel
    // delivery receipts — visible to admins even in environments where real
    // email delivery is disabled (the outbox records them as logged).
    await demoStep(test, page, 'Notifications — Admin tours the outbox, owner-route approval staged with delivery receipts', async () => {
      await login(page, SUPERADMIN.email, SUPERADMIN.password);
      await openAdminTab(page, 'sent-notifications', 'admin-sent-notifications__table');
      const ownerRouteRow = page.getByTestId('admin-sent-notifications__row')
        .filter({ hasText: 'request.step_approved_owner' }).first();
      await expect(ownerRouteRow).toBeVisible();
      await expect(ownerRouteRow.getByTestId('admin-sent-notifications__recipients-cell'))
        .toContainText(scenario.owner.email);
      await clickWithCapture(page, 'demo-outbox-open-detail', ownerRouteRow);
      const detail = modalByTestId(page, 'admin-sent-notifications__detail-modal');
      await expect(detail).toBeVisible();
      await expect(detail).toContainText('request.step_approved_owner');
      await clickWithCapture(page, 'demo-outbox-close-detail', detail.getByTestId('admin-sent-notifications__detail-close-button'));
      await expect(detail).not.toBeVisible();
    });

    await demoStep(test, page, 'Accessibility — Skip-to-content keyboard link', async () => {
      await login(page, scenario.owner.email, scenario.owner.password);
      // Reset focus to the document start, then a single Tab reveals and
      // focuses the skip link (it is screen-reader-only until focused);
      // activating it moves focus straight into the main content region —
      // no keyboard user has to tab through the whole header chrome.
      await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); });
      await page.keyboard.press('Tab');
      const skipLink = page.getByTestId('dashboard__skip-to-content');
      await expect(skipLink).toBeFocused();
      await expect(skipLink).toBeVisible();
      await captureBefore(page, 'demo-a11y-skip-link');
      await page.keyboard.press('Enter');
      await expect(page.locator('#main-content')).toBeFocused();
      await captureAfter(page, 'demo-a11y-skip-link');
    });

    await demoStep(test, page, 'Physical Custody — AWS lockdown routes the declared API asset into custody', async () => {
      await openPendingDashboardRequest(page, request1Number, 'owner-dashboard__view-button');
      await expect(page.getByTestId('request-detail__fulfillment-preview')).toBeVisible();
      await expect(page.getByTestId('request-detail__preview-custody')).toContainText('tok-emergency-001');
      await expect(page.getByTestId('request-detail__preview-exchange')).toHaveCount(0);
      await clickWithCapture(page, 'demo-owner-approve-from-preview', page.getByTestId('request-detail-view__owner-approve-button'));
      const modal = modalByTestId(page, 'request-detail-view__action-modal');
      await submitWithCapture(page, 'demo-owner-confirm-custody-route', modal.getByTestId('request-detail-view__confirm-button'));
      await expect(modal).not.toBeVisible();
      await expect(page.getByTestId('request-detail__fork-track-custody')).toBeVisible();
    });

    await demoStep(test, page, 'Physical Custody — Agency custodian prepares and hands over', async () => {
      await login(page, scenario.agencyL1B.email, scenario.agencyL1B.password);
      await openPendingDashboardRequest(page, request1Number, 'agency-dashboard__view-button');
      const custodyCase = page.getByTestId('request-custody__case-list').getByRole('article').filter({ hasText: 'tok-emergency-001' });
      await custodyCase.getByRole('checkbox').check();
      await clickWithCapture(page, 'demo-custody-prepare-handover', page.getByTestId('request-custody__batch-prepare_and_handover'));
      await expect(custodyCase).toContainText(/handover pending/i);
    });

    await demoStep(test, page, 'Physical Custody — Requester confirms receipt, credential issued automatically', async () => {
      await login(page, scenario.vendorL1A.email, scenario.vendorL1A.password);
      await openPendingDashboardRequest(page, request1Number, 'vendor-dashboard__view-button');
      const custodyCase = page.getByTestId('request-custody__case-list').getByRole('article').filter({ hasText: 'tok-emergency-001' });
      await clickWithCapture(page, 'demo-custody-confirm-receipt', custodyCase.getByRole('button', { name: 'Confirm receipt' }));
      await expect(custodyCase).toContainText(/requester custody/i);
      await expect(page.getByText(/credential issued/i).first()).toBeVisible();
    });

    await demoStep(test, page, 'Physical Custody — Agency closes the issued request, return stays open', async () => {
      await login(page, scenario.agencyL1B.email, scenario.agencyL1B.password);
      await clickWithCapture(page, 'demo-close-open-modal', await pendingDashboardAction(page, request1Number, 'agency-dashboard__close-button'));
      const closeModal = modalByTestId(page, 'agency-dashboard__action-modal');
      await submitWithCapture(page, 'demo-close-request', closeModal.getByTestId('agency-dashboard__confirm-button'));
      await expect(closeModal).not.toBeVisible();
    });

    await demoStep(test, page, 'Physical Custody — Closed request warns custody is open, requester initiates return', async () => {
      await login(page, scenario.vendorL1A.email, scenario.vendorL1A.password);
      await openPendingDashboardRequest(page, request1Number, 'vendor-dashboard__view-button');
      await expect(page.getByTestId('request-detail__closed-custody-warning')).toBeVisible();
      const custodyCase = page.getByTestId('request-custody__case-list').getByRole('article').filter({ hasText: 'tok-emergency-001' });
      await clickWithCapture(page, 'demo-custody-initiate-return', custodyCase.getByRole('button', { name: 'Initiate return' }));
      await expect(custodyCase).toContainText(/return pending/i);
    });

    await demoStep(test, page, 'Physical Custody — Agency verifies return, restores inventory', async () => {
      await login(page, scenario.agencyL1B.email, scenario.agencyL1B.password);
      await openPendingDashboardRequest(page, request1Number, 'agency-dashboard__view-button');
      const custodyCase = page.getByTestId('request-custody__case-list').getByRole('article').filter({ hasText: 'tok-emergency-001' });
      await custodyCase.getByRole('checkbox').check();
      await clickWithCapture(page, 'demo-custody-verify-restock', page.getByTestId('request-custody__batch-verify_and_restock'));
      await expect(page.getByTestId('request-custody__summary')).toContainText('1 of 1 returned');
      await expect(page.getByTestId('request-detail__closed-custody-warning')).toHaveCount(0);
    });

    await demoStep(test, page, 'Access Log — Vendor views the closed request and its audit trail', async () => {
      await login(page, scenario.vendorL1A.email, scenario.vendorL1A.password);
      const row = page.locator('tr', { hasText: request1Number });
      await expect(row).toContainText(/closed/i);

      await clickWithCapture(page, 'demo-view-closed-detail', row.getByTestId('vendor-dashboard__view-button'), { waitForLocator: page.getByTestId('request-detail-view__back-button') });
      // Request detail disclosures are expanded by default — no click needed.
      const credentialsDisclosure = page.getByTestId('request-detail-view__credentials-disclosure');
      await expect(credentialsDisclosure).toHaveAttribute('open', '');
      await expect(page.getByTestId('request-detail-view__credential-type-badge')).toHaveText('token');

      const auditDisclosure = page.getByTestId('request-detail-view__audit-disclosure');
      await expect(auditDisclosure).toHaveAttribute('open', '');
      const accessLogModal = modalByTestId(page, 'request-detail-view__access-log-modal');
      await clickWithCapture(
        page, 'demo-view-access-log',
        auditDisclosure.getByTestId('request-detail-view__access-log-link').first(),
        { waitForLocator: accessLogModal },
      );
      await accessLogModal.getByTestId('request-detail-view__access-log-modal__close-button').click();
      await expect(accessLogModal).not.toBeVisible();
    });

    // ── Requests #2 and #3: carried up to the owner terminal and left
    // PENDING — the fixture data the delegate storyline below acts on.
    // Driven through each assigned actor's pending dashboard
    // using the captured server request number as the unambiguous row anchor. By this
    // point "submit a request" and "approve from pending dashboard" have each already
    // played at full pace at least twice (request #1's stretch above), so
    // every one of these steps runs accelerated automatically. ───────────

    // Returns the server-assigned request_number (e.g. BG-DEMO1-...) — the
    // ONLY thing dashboard rows ever render as on-screen text; the caller-
    // chosen sr_number never appears in a dashboard row, only in Search
    // results / RequestDetailView, so the delegate-visibility assertions
    // below need this, not srNumber, as their anchor.
    async function submitAndClearToOwnerTerminal(
      srNumber: string, hostname: string, credentialName: string, label: string,
    ): Promise<string> {
      let requestNumber = '';
      await demoStep(test, page, `Vendor L1 submits break-glass request ${label}`, async () => {
        requestNumber = await submitRequestAsVendor(srNumber, hostname, credentialName, label);
      });

      await demoStep(test, page, `Vendor L2 approves step 1 of request ${label}`, async () => {
        await login(page, scenario.vendorL2A.email, scenario.vendorL2A.password);
        await decideViaDashboard(requestNumber, 'vendor', `${label}-vl2`);
      });

      await demoStep(test, page, `Agency L1 approves step 2 of request ${label}`, async () => {
        await login(page, scenario.agencyL1A.email, scenario.agencyL1A.password);
        await decideViaDashboard(requestNumber, 'agency', `${label}-agl1`);
      });

      await demoStep(test, page, `Agency L2 approves step 3 of request ${label}, routing it to the owner`, async () => {
        await login(page, scenario.agencyL2A.email, scenario.agencyL2A.password);
        await decideViaDashboard(requestNumber, 'agency', `${label}-agl2`);
      });

      return requestNumber;
    }

    request2Number = await submitAndClearToOwnerTerminal('SR-DEMO002', 'vault.staging.internal', 'tok-emergency-002', '#2');
    request3Number = await submitAndClearToOwnerTerminal('SR-DEMO003', 'vault.dr.internal', 'tok-emergency-003', '#3');

    // ── Owner feature showcase ────────────────────────────────────────────
    // Beyond the base happy-path lifecycle: tour the owner-only Statistics
    // tab (pie/bar breakdown charts) and the My Systems & Delegates tab,
    // then the full delegate lifecycle (add -> delegate approves one of
    // the two pending requests -> remove -> delegate loses all access,
    // immediately, without re-login) — per explicit demo scope request.
    await demoStep(test, page, 'Owner Tools — Statistics tab, pie and bar charts', async () => {
      await login(page, scenario.owner.email, scenario.owner.password);
      await clickWithCapture(page, 'demo-owner-open-statistics-tab', page.getByTestId('owner-dashboard__tab-statistics'));
      await expect(page.getByTestId('statistics-view__apply-button')).toBeVisible();

      // Widen "To" to end-of-day so the just-closed demo request (created
      // moments ago) safely falls inside the half-open [from, to) interval —
      // same reasoning as owner-statistics.spec.ts's default-range fixup.
      await pickDateTime(page, page.getByTestId('statistics-view__to-picker'), { hour: '23', minute: '59' });

      await submitWithCapture(page, 'demo-statistics-pie', page.getByTestId('statistics-view__apply-button'));
      const pieChart = page.getByTestId('statistics-view__pie-chart');
      await expect(pieChart).toBeVisible();
      await captureElement(pieChart, 'demo-statistics-pie');

      await clickWithCapture(
        page, 'demo-statistics-bar',
        page.getByTestId('statistics-view__chart-type-bar'),
        { waitForLocator: page.getByTestId('statistics-view__bar-chart') },
      );
      const barChart = page.getByTestId('statistics-view__bar-chart');
      await captureElement(barChart, 'demo-statistics-bar');
    });

    await demoStep(test, page, 'Owner Tools — My Systems and Delegates overview', async () => {
      await clickWithCapture(page, 'demo-owner-open-systems-tab', page.getByTestId('owner-dashboard__tab-systems'));
      const header = page.locator('div', { hasText: SYSTEM_NAME })
        .filter({ has: page.getByTestId('owner-systems-view__system-header') })
        .getByTestId('owner-systems-view__system-header')
        .first();
      await clickWithCapture(page, 'demo-owner-expand-system', header);
    });

    // A fresh, team-less actor — not one of the 8 workflow-role actors —
    // signs up now, before the owner adds them as a delegate, so the
    // delegate's ONLY relationship to this system is the delegation itself
    // (no vendor/agency step-reviewer role muddying the story).
    //
    // Time-bound delegation (addendum-113/140): activeFrom/activeUntil on
    // the delegate record, enforced by canApprove() (server/auth.tsx) at
    // DECISION time. There is no PATCH endpoint for an existing delegate's
    // window (server/app.tsx only registers POST add / DELETE remove), so
    // "the owner updates the limit" below is remove-then-re-add with new
    // bounds — exactly what a real owner has to do today.
    async function openOwnerSystemHeader(): Promise<void> {
      await login(page, scenario.owner.email, scenario.owner.password);
      await page.getByTestId('owner-dashboard__tab-systems').click();
      const header = page.locator('div', { hasText: SYSTEM_NAME })
        .filter({ has: page.getByTestId('owner-systems-view__system-header') })
        .getByTestId('owner-systems-view__system-header')
        .first();
      await header.click();
    }

    async function addDelegate(window?: { from?: Date; until?: Date }): Promise<void> {
      await clickWithCapture(page, 'demo-owner-open-add-delegate', page.getByTestId('owner-systems-view__add-delegate-button'));
      const select = page.getByTestId('owner-systems-view__delegate-select');
      const optionValue = await select
        .locator('option', { hasText: DELEGATE.fullName })
        .getAttribute('value');
      await select.selectOption(optionValue!);
      if (window) {
        await clickWithCapture(page, 'demo-owner-limit-delegate-window', page.getByTestId('owner-systems-view__delegate-window-toggle'));
        if (window.from) {
          await pickDateTime(page, page.getByTestId('owner-systems-view__delegate-from-picker'), { hour: '09', minute: '00', date: window.from });
        }
        if (window.until) {
          await pickDateTime(page, page.getByTestId('owner-systems-view__delegate-until-picker'), { hour: '23', minute: '59', date: window.until });
        }
      }
      await submitWithCapture(page, 'demo-owner-confirm-add-delegate', page.getByTestId('owner-systems-view__confirm-add-delegate-button'));
      await expect(page.getByText(DELEGATE.fullName, { exact: true })).toBeVisible();
    }

    async function removeDelegate(): Promise<void> {
      page.once('dialog', (dialog) => dialog.accept());
      await submitWithCapture(page, 'demo-owner-remove-delegate', page.getByTestId('owner-systems-view__remove-delegate-button'));
      await expect(page.getByText(DELEGATE.fullName)).toHaveCount(0);
    }

    await demoStep(test, page, 'Delegation — New agency user signs up to become delegate', async () => {
      await signup(page, DELEGATE);
      await login(page, SUPERADMIN.email, SUPERADMIN.password);
      await approveUser(page, DELEGATE.email, 'agency', 0, scenario.agencyOrgName);
    });

    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await demoStep(test, page, 'Delegation — Owner assigns the delegate with a window that starts tomorrow', async () => {
      await openOwnerSystemHeader();
      // The owner-side add form requires BOTH bounds once the window toggle
      // is on (useOwnerSystems.ts's client-side gate is stricter than the
      // server schema, which allows one-sided) — both future, same day.
      await addDelegate({ from: tomorrow, until: tomorrow });
      await expect(page.getByTestId('owner-systems-view__delegate-window-chip')).toBeVisible();
    });

    // getDelegatedSystems() (server/auth.tsx) — which drives whether the
    // delegate even sees this workspace and its rows — does NOT check the
    // activeFrom/activeUntil window; only canApprove() does, at decision
    // time. So the delegate still sees the dashboard and an enabled Approve
    // button here — the window is enforced at the point of action, not
    // visibility. Deliberate app behavior, not a gap — the refusal below is
    // the actual enforcement point this step demonstrates.
    await demoStep(test, page, 'Delegation — Delegate tries to approve before the window opens, and is refused', async () => {
      await login(page, DELEGATE.email, DELEGATE.password);
      await expect(page.getByText('Delegated Approvals')).toBeVisible();
      const row = page.locator('tr', { hasText: request2Number });
      await expect(row).toBeVisible();
      await clickWithCapture(page, 'demo-delegate-refused-open', row.getByTestId('delegate-approval-panel__approve-button'));
      const modal = modalByTestId(page, 'delegate-approval-panel__action-modal');
      await submitWithCapture(page, 'demo-delegate-refused-confirm', modal.getByTestId('delegate-approval-panel__confirm-button'));
      await expect(modal.getByText(/not authorized/i)).toBeVisible();
      await captureElement(modal, 'demo-delegate-refused-alert');
      await modal.getByTestId('delegate-approval-panel__cancel-button').click();
      await expect(modal).not.toBeVisible();
    });

    await demoStep(test, page, 'Delegation — Owner updates the window to include the present', async () => {
      await openOwnerSystemHeader();
      await removeDelegate();
      await addDelegate({ from: new Date(), until: tomorrow });
    });

    // A pure delegate now receives the dedicated Delegate Approver dashboard
    // hat rather than being folded into the system owner's workspace.
    await demoStep(test, page, 'Delegation — Delegate lands in the workspace, now inside the active window', async () => {
      await login(page, DELEGATE.email, DELEGATE.password);
      await expect(page.getByText('Delegated Approvals')).toBeVisible();
      await expect(page.locator('tr', { hasText: request2Number })).toBeVisible();
      await expect(page.locator('tr', { hasText: request3Number })).toBeVisible();
      await expect(page.locator('tr', { hasText: request2Number }).getByTestId('delegate-approval-panel__approve-button')).toBeEnabled();
    });

    await demoStep(test, page, 'Delegation — Delegate approves request #2 on the owner\'s behalf', async () => {
      await decideViaDashboard(request2Number, 'delegate', 'delegate');
    });

    await demoStep(test, page, 'Delegation — Owner revokes the delegation entirely', async () => {
      await openOwnerSystemHeader();
      await removeDelegate();
    });

    // With the delegation gone, the dedicated Delegate Approver hat disappears
    // and the team-less actor falls back to an empty Agency Engineer dashboard.
    await demoStep(test, page, 'Delegation — Former delegate sees no delegated requests at all', async () => {
      await login(page, DELEGATE.email, DELEGATE.password);
      await expect(page.getByText('Delegated Approvals')).toHaveCount(0);
      await expect(page.getByTestId('delegate-approval-panel__approve-button')).toHaveCount(0);
      await expect(page.getByText(request2Number)).toHaveCount(0);
      await expect(page.getByText(request3Number)).toHaveCount(0);
    });

    await demoStep(test, page, 'Delegation — Former delegate searches and finds nothing', async () => {
      await clickWithCapture(page, 'demo-open-search-former-delegate', page.getByTestId('dashboard__search-button'));
      await page.getByTestId('search-overlay__query-input').fill('SR-DEMO003');
      await expect(page.getByText('No requests match your search.')).toBeVisible();
      await expect(page.getByTestId('search-overlay__result-button')).toHaveCount(0);
    });

    // Closing assurance beat: the whole recording ran without the console
    // warnings addendum-193 eliminated (React key/act warnings and friends) —
    // a pinned guard so console regressions can never ship ON camera again.
    await demoStep(test, page, 'Wrap-up — Console hygiene, warning-free recording', async () => {
      const noisy = harness.consoleLog()
        .filter((e) => e.type === 'error' || e.type === 'pageerror')
        .filter((e) => /unique "key" prop|not wrapped in act|Each child in a list|validateDOMNesting/i.test(e.text));
      expect(noisy, `console hygiene violations on camera: ${noisy.map((e) => e.text).join(' | ')}`).toEqual([]);
    });
  });
});
