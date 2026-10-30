// Browser-driven coverage for the full RequestDetailView action branching and
// password retrieval gate (addendum-028 / addendum-031), walking one request
// through its whole lifecycle via the detail view:
//   1. current-reviewer action matrix (only step Approve/Return/Reject; no
//      owner actions, no password retrieval),
//   2. rejection-notes validation (confirming with no notes shows the
//      required-notes error; Cancel closes the modal with the request
//      unchanged),
//   3. approval progression (each reviewer's approval advances the request;
//      the owner sees owner-specific actions),
//   4. the password-retrieval gate during the async delivery gap: hidden for a
//      non-submitter reviewer; the original requester sees the "preparing"
//      notice (retrieval is not offered until delivery lands — the actual
//      decrypt-through-UI is covered by aws-localstack.spec.ts, which runs
//      against real LocalStack delivery),
//   5. credential issue + request close from Request Detail, and the
//      retrieval option disappearing once closed.
//
// Everything runs through real browser UI — no API/DB shortcuts.
import { test, expect } from '../helpers/harness';
import { E2E_USER_EMAIL, E2E_USER_PASSWORD } from '../global-setup';
import {
  login, modalByTestId, pickDateTime, submitWithCapture,
  submitRequestIdentityWithCapture, createAssetViaAdminUI, fillCredentialItemCombobox,
  openPendingDashboardRequest, getSessionCookie,
} from '../helpers/ui';
import { provisionActorsAndTeams, provisionSystem, type ProvisionedScenario } from '../helpers/scenario';

const SUPERADMIN = { email: E2E_USER_EMAIL, password: E2E_USER_PASSWORD };
const SHORT_CODE = 'RDV';
const SYSTEM_NAME = 'Request Detail Test System';
const SYSTEM_LABEL = `${SHORT_CODE} — ${SYSTEM_NAME}`;
const SR_NUMBER = 'SR-RDV001';
const ASSET_HOSTNAME = 'rdv-host';
const ASSET_CRED = 'svc_rdv';
// Same fixed backend port as config/playwright.config.ts / helpers/ui.ts.
const E2E_BACKEND_URL = process.env['E2E_BACKEND_URL'] ?? `http://localhost:${8789 + Number(process.env['E2E_STACK_ID'] ?? 0) * 10000}`;

// Writes one app-setting key via the superadmin API using the same CSRF +
// idempotency-token pattern as pending-actions-digest.spec.ts.
async function writeAppSetting(page: any, key: string, value: string): Promise<void> {
  const session = await getSessionCookie(page);
  const sessionHeaders: Record<string, string> = session ? { 'X-Session-Token': session } : {};
  const snap = await page.request.get(`${E2E_BACKEND_URL}/me/capability-snapshot`, { headers: sessionHeaders });
  const { idempotencyToken } = await snap.json() as { idempotencyToken: string };
  const allCookies = await page.context().cookies();
  const csrfCookie = allCookies.find((c: { name: string }) => c.name === 'ffs_csrf' || c.name === '__Host-ffs_csrf');
  const csrfHeaders: Record<string, string> = csrfCookie ? { 'X-CSRF-Token': (csrfCookie as { value: string }).value } : {};
  const res = await page.request.put(`${E2E_BACKEND_URL}/admin/app-settings/${key}`, {
    headers: { ...sessionHeaders, ...csrfHeaders, 'X-Idempotency-Token': idempotencyToken },
    data: { value },
  });
  expect(res.status(), `setting ${key}=${JSON.stringify(value)} succeeds`).toBe(200);
}

// Issues a real browser GET to the wrap-key retrieval API
// (/requests/:id/secret-material) for the currently-logged-in submitter and
// returns the HTTP status + body — proves the backend gates the wrap key, not
// just the UI. Session rides on the HttpOnly cookie (credentials:'include').
async function directSecretMaterial(page: any, requestId: string): Promise<{ status: number; body: any }> {
  return page.evaluate(async ({ base, id }: { base: string; id: string }) => {
    const res = await fetch(`${base}/requests/${id}/secret-material`, { credentials: 'include' });
    return { status: res.status, body: await res.json().catch(() => null) };
  }, { base: E2E_BACKEND_URL, id: requestId });
}

test.describe('RequestDetailView action branching and password retrieval', () => {
  test('full reviewer action matrix, rejection-notes validation, approval progression, password retrieval gate, and issue/close', async ({ page }) => {
    let scenario!: ProvisionedScenario;
    let requestId = '';
    let requestNumber = '';
    let originalAwsIntegration = 'false';

    async function openDetailFromPendingDashboard(role: 'vendor' | 'agency' | 'owner') {
      await openPendingDashboardRequest(page, requestNumber, `${role}-dashboard__view-button`);
    }

    await test.step('provision actors/teams, a system, and a password-type asset', async () => {
      scenario = await provisionActorsAndTeams(page, SUPERADMIN, 'rdv');
      await login(page, SUPERADMIN.email, SUPERADMIN.password);
      // Enable AWS integration so credential items route through the exchange
      // flow (not physical custody) — makes the issue/close buttons appear.
      // Save the original value to restore after the test.
      const settingsRes = await page.request.get(`${E2E_BACKEND_URL}/admin/app-settings`, {
        headers: { 'X-Session-Token': (await getSessionCookie(page)) ?? '' },
      });
      const settingsBody = await settingsRes.json() as { settings: Array<{ key: string; value: string }> };
      originalAwsIntegration = settingsBody.settings.find((s) => s.key === 'aws_integration_enabled')?.value ?? 'false';
      await writeAppSetting(page, 'aws_integration_enabled', 'true');
      await provisionSystem(page, scenario, { shortCode: SHORT_CODE, name: SYSTEM_NAME, awsRoleArnNote: 'arn:aws:iam::123456789012:role/rdv-test' });
      await createAssetViaAdminUI(page, {
        systemLabel: SYSTEM_LABEL, hostname: ASSET_HOSTNAME, credentialName: ASSET_CRED, credentialType: 'password', navigateFirst: true,
      });
    });

    let keyFilePath = '';

    await test.step('vendor L1 submits a Password-type request (client-side keygen) — the wrapped private-key file is MANDATORILY downloaded', async () => {
      await login(page, scenario.vendorL1A.email, scenario.vendorL1A.password);
      await page.getByTestId('vendor-dashboard__open-submit-button').click();
      await page.getByTestId('vendor-dashboard__system-select').selectOption({ label: `${SYSTEM_NAME} (${SHORT_CODE})` });
      await page.getByTestId('vendor-dashboard__sr-number-input').fill(SR_NUMBER);
      await page.getByTestId('vendor-dashboard__justification-textarea').fill('Production incident requiring emergency password access.');
      await pickDateTime(page, page.getByTestId('vendor-dashboard__activity-start-picker'), { hour: '00', minute: '00' });
      await pickDateTime(page, page.getByTestId('vendor-dashboard__activity-end-picker'), { hour: '23', minute: '59' });
      await fillCredentialItemCombobox(page.getByTestId('vendor-dashboard__credential-item'), ASSET_HOSTNAME, ASSET_CRED);

      // Every submit must push the wrapped private-key file down to the user.
      // Race the submit click against the download event and assert a file
      // actually landed (mandatory download, Variant B).
      const [download] = await Promise.all([
        page.waitForEvent('download'),
        (async () => {
          const submitted = await submitRequestIdentityWithCapture(page, 'rdv-submit', page.getByTestId('vendor-dashboard__submit-request-button'));
          requestId = submitted.id;
          requestNumber = submitted.requestNumber;
        })(),
      ]);
      expect(requestId).toBeTruthy();
      keyFilePath = (await download.path()) as string;
      expect(keyFilePath).toBeTruthy();
      expect(download.suggestedFilename()).toMatch(/private-key\.txt$/);
    });

    await test.step('wrap-key retrieval API: errors before approval (the wrap key is not yielded until the request is approved)', async () => {
      // Still logged in as the submitter from the submit step. Before approval
      // the request is not in an eligible status, so the API must error (403)
      // and must NOT yield the wrap key.
      const res = await directSecretMaterial(page, requestId);
      expect(res.status).toBe(403);
      expect(res.body.privateKeyWrapKey).toBeUndefined();
    });

    await test.step('C.1 current-reviewer action matrix: vendor L2 sees only step actions', async () => {
      await login(page, scenario.vendorL2A.email, scenario.vendorL2A.password);
      await openDetailFromPendingDashboard('vendor');

      await expect(page.getByTestId('request-detail-view__step-approve-button')).toBeVisible();
      await expect(page.getByTestId('request-detail-view__step-return-button')).toBeVisible();
      await expect(page.getByTestId('request-detail-view__step-reject-button')).toBeVisible();

      // Owner actions absent.
      await expect(page.getByTestId('request-detail-view__owner-approve-button')).toHaveCount(0);
      await expect(page.getByTestId('request-detail-view__owner-return-button')).toHaveCount(0);
      await expect(page.getByTestId('request-detail-view__owner-reject-button')).toHaveCount(0);
      // Password retrieval absent pre-approval (and for a non-submitter).
      await expect(page.getByTestId('request-detail-view__retrieve-password-button')).toHaveCount(0);
      // Issue/close absent pre-approval.
      await expect(page.getByTestId('request-detail-view__issue-button')).toHaveCount(0);
      await expect(page.getByTestId('request-detail-view__close-button')).toHaveCount(0);
    });

    await test.step('C.2 rejection notes validation: confirm with no notes shows the required-notes error; Cancel closes cleanly', async () => {
      await login(page, scenario.vendorL2A.email, scenario.vendorL2A.password);
      await openDetailFromPendingDashboard('vendor');

      await page.getByTestId('request-detail-view__step-reject-button').click();
      const modal = modalByTestId(page, 'request-detail-view__action-modal');
      await expect(modal).toBeVisible();
      await modal.getByTestId('request-detail-view__confirm-button').click();
      await expect(modal.getByText(/cannot be empty/i)).toBeVisible();

      // Cancel closes the modal; the request is unchanged (still at vendor L2's
      // step, so step-approve remains available).
      await modal.getByTestId('request-detail-view__cancel-button').click();
      await expect(modal).not.toBeVisible();
      await expect(page.getByTestId('request-detail-view__step-approve-button')).toBeVisible();
    });

    await test.step('C.3 approval progression: vendor L2 approves from Request Detail', async () => {
      await login(page, scenario.vendorL2A.email, scenario.vendorL2A.password);
      await openDetailFromPendingDashboard('vendor');
      await page.getByTestId('request-detail-view__step-approve-button').click();
      let modal = modalByTestId(page, 'request-detail-view__action-modal');
      await modal.getByTestId('request-detail-view__confirm-button').click();
      await expect(modal).not.toBeVisible();
    });

    await test.step('C.3 agency L1 approves from Request Detail', async () => {
      await login(page, scenario.agencyL1A.email, scenario.agencyL1A.password);
      await openDetailFromPendingDashboard('agency');
      await page.getByTestId('request-detail-view__step-approve-button').click();
      let modal = modalByTestId(page, 'request-detail-view__action-modal');
      await modal.getByTestId('request-detail-view__confirm-button').click();
      await expect(modal).not.toBeVisible();
    });

    await test.step('C.3 agency L2 approves from Request Detail (routes to owner terminal)', async () => {
      await login(page, scenario.agencyL2A.email, scenario.agencyL2A.password);
      await openDetailFromPendingDashboard('agency');
      await page.getByTestId('request-detail-view__step-approve-button').click();
      let modal = modalByTestId(page, 'request-detail-view__action-modal');
      await modal.getByTestId('request-detail-view__confirm-button').click();
      await expect(modal).not.toBeVisible();
    });

    await test.step('C.3 owner opens Request Detail and sees owner-specific actions; owner approves', async () => {
      await login(page, scenario.owner.email, scenario.owner.password);
      await openDetailFromPendingDashboard('owner');

      await expect(page.getByTestId('request-detail-view__owner-approve-button')).toBeVisible();
      await expect(page.getByTestId('request-detail-view__owner-return-button')).toBeVisible();
      await expect(page.getByTestId('request-detail-view__owner-reject-button')).toBeVisible();

      await page.getByTestId('request-detail-view__owner-approve-button').click();
      const modal = modalByTestId(page, 'request-detail-view__action-modal');
      await submitWithCapture(page, 'rdv-owner-approve', modal.getByTestId('request-detail-view__confirm-button'));
      await expect(modal).not.toBeVisible();
    });

    await test.step('wrap-key retrieval API: errors in the approved-but-not-yet-delivered gap (409 — no wrap key until the AWS response is back)', async () => {
      // Approved now, but this suite has no LocalStack so delivery has not
      // landed (encrypted_secret_payload is null). The API must return 409 and
      // must NOT yield the wrap key — only once the AWS response is back (and
      // the button becomes active) does it succeed, which is covered by
      // aws-localstack.spec.ts / the backend test.
      await login(page, scenario.vendorL1A.email, scenario.vendorL1A.password);
      const res = await directSecretMaterial(page, requestId);
      expect(res.status).toBe(409);
      expect(res.body.privateKeyWrapKey).toBeUndefined();
    });

    await test.step('C.4 after owner approval (async delivery gap): a non-submitter reviewer sees nothing; the submitter sees the "preparing" notice', async () => {
      // This regression suite has no LocalStack, so delivery never lands here:
      // secret_material_ready stays false and the submitter sees the
      // "preparing" notice instead of the Retrieve button — the exact UX for
      // the real async gap. (The full decrypt-through-UI, once LocalStack
      // delivers, runs in aws-localstack.spec.ts.)
      await login(page, scenario.agencyL1A.email, scenario.agencyL1A.password);
      await openDetailFromPendingDashboard('agency');
      await expect(page.getByTestId('request-detail-view__retrieve-password-button')).toHaveCount(0);
      // Non-submitter: no preparing notice either.
      await expect(page.getByTestId('request-detail-view__password-preparing-notice')).toHaveCount(0);

      await login(page, scenario.vendorL1A.email, scenario.vendorL1A.password);
      await openDetailFromPendingDashboard('vendor');
      // Submitter: retrieval not offered yet (delivery pending) — the
      // "preparing" notice is shown instead.
      await expect(page.getByTestId('request-detail-view__retrieve-password-button')).toHaveCount(0);
      await expect(page.getByTestId('request-detail-view__password-preparing-notice')).toBeVisible();
    });

    await test.step('wrap-key retrieval API: submitter-only — a reviewer and the owner (who can view the request) are 404 and never get the wrap key', async () => {
      // Retrieval is strictly submitter-gated. A reviewer and the owner can
      // VIEW this request (they've been acting on it), but they are NOT the
      // submitter, so the wrap-key endpoint must 404 and yield no key.
      for (const actor of [scenario.agencyL1A, scenario.owner]) {
        await login(page, actor.email, actor.password);
        const res = await directSecretMaterial(page, requestId);
        expect(res.status, `non-submitter ${actor.email} must be 404`).toBe(404);
        expect(res.body.privateKeyWrapKey).toBeUndefined();
      }
    });

    await test.step('C.5 an authorized agency reviewer issues the credential from Request Detail', async () => {
      await login(page, scenario.agencyL1A.email, scenario.agencyL1A.password);
      await openDetailFromPendingDashboard('agency');
      await expect(page.getByTestId('request-detail-view__issue-button')).toBeVisible();

      await page.getByTestId('request-detail-view__issue-button').click();
      let modal = modalByTestId(page, 'request-detail-view__action-modal');
      await modal.getByTestId('request-detail-view__confirm-button').click();
      await expect(modal).not.toBeVisible();
    });

    await test.step('C.5 Close Request becomes visible; close it and assert Closed status', async () => {
      await login(page, scenario.agencyL1A.email, scenario.agencyL1A.password);
      await openDetailFromPendingDashboard('agency');
      await expect(page.getByTestId('request-detail-view__close-button')).toBeVisible();

      await page.getByTestId('request-detail-view__close-button').click();
      const modal = modalByTestId(page, 'request-detail-view__action-modal');
      await modal.getByTestId('request-detail-view__confirm-button').click();
      await expect(modal).not.toBeVisible();

      // Visible Closed status on the requester's dashboard row.
      await login(page, scenario.vendorL1A.email, scenario.vendorL1A.password);
      await expect(page.locator('tr', { hasText: requestNumber })).toContainText(/closed/i);
    });

    await test.step('C.5 once closed, no action/retrieval buttons remain for any viewer', async () => {
      // Every action button the detail view can render, keyed off its
      // data-testid. After a request is closed, NONE of these should be
      // present for any viewer — the workflow is terminal, so there is
      // nothing left to approve/return/reject/issue/close/reset/retrieve.
      const actionButtonTestIds = [
        'request-detail-view__step-approve-button',
        'request-detail-view__step-return-button',
        'request-detail-view__step-reject-button',
        'request-detail-view__owner-approve-button',
        'request-detail-view__owner-return-button',
        'request-detail-view__owner-reject-button',
        'request-detail-view__issue-button',
        'request-detail-view__close-button',
        'request-detail-view__admin-reset-button',
        'request-detail-view__edit-request-button',
        'request-detail-view__retrieve-password-button',
        'request-detail-view__close-request-button',
      ];

      async function assertNoButtonsRemain(): Promise<void> {
        for (const testId of actionButtonTestIds) {
          await expect(page.getByTestId(testId), `expected no ${testId} once closed`).toHaveCount(0);
        }
        // The action panel (retrieve / available-actions) is gone entirely.
        await expect(page.getByTestId('request-detail-view__password-preparing-notice')).toHaveCount(0);
        // Only the plain navigation back button remains.
        await expect(page.getByTestId('request-detail-view__back-button')).toBeVisible();
      }

      // As the original submitter.
      await login(page, scenario.vendorL1A.email, scenario.vendorL1A.password);
      await openDetailFromPendingDashboard('vendor');
      await assertNoButtonsRemain();

      // As an agency reviewer (who previously had issue/close/admin-reset
      // capability before the request closed).
      await login(page, scenario.agencyL1A.email, scenario.agencyL1A.password);
      await openDetailFromPendingDashboard('agency');
      await assertNoButtonsRemain();

      // As the owner (who previously had owner-approve/return/reject).
      await login(page, scenario.owner.email, scenario.owner.password);
      await openDetailFromPendingDashboard('owner');
      await assertNoButtonsRemain();
    });

    await test.step('restore aws_integration_enabled to its original value', async () => {
      await login(page, SUPERADMIN.email, SUPERADMIN.password);
      await writeAppSetting(page, 'aws_integration_enabled', originalAwsIntegration);
    });
  });
});
