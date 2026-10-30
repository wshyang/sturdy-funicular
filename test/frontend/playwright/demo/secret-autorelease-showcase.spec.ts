// Demo showcase for the automated password release pipeline — a SEPARATE
// demo-recording target from the main demo suite (happy-path-showcase.spec.ts,
// run via `pnpm run demo:e2e`). Run via
// `pnpm run demo:e2e:secret-autorelease` against
// config/playwright.demo-secret-autorelease.config.ts (HD video, paced actions, and —
// unlike the main demo config — AWS_INTEGRATION_ENABLED pointed at LocalStack,
// so delivery is REAL: publish -> EventBridge -> Lambda -> /health sweep ->
// retrieve -> decrypt). See
// addendum-031-test-only-secret-autorelease-and-cloudformation.md.
//
// REQUIRES LocalStack running (`docker compose up -d`) and bootstrapped
// (`deno task localstack:bootstrap`) — this spec also exercises a real
// S3 asset-inventory sync against it (addendum-043-asset-inventory-sync-e2e-
// and-demo-coverage.md), the delegate-free demo suite's counterpart to
// e2e/aws-localstack.spec.ts's own coverage of the same "Sync Now" flow.
//
// Narrative: automatically sync the system's asset inventory from a real
// (LocalStack-emulated) S3/EventBridge/Lambda round trip, curate two more
// assets by hand -> submit a Password-type request (a real RSA keypair
// generates and the encrypted private key downloads automatically) -> carry
// it through approval to the owner terminal -> GET /health prompts the
// centralized sweep to deliver the real encrypted password -> the requester
// opens Retrieve Password, uploads the downloaded key file, and sees the
// password decrypted entirely client-side.
//
// Addendum-194 refresh: the suite now runs on the UNIFIED harness
// (../harness/test.ts — pacing + viewport-centering + captions on top of the
// observable harness) and picks up two feature beats the app has grown since
// this video was first cut: the requester's mandatory first-login 2FA
// enrollment as its own captured moment, and the notification-OUTBOX tour
// showing the delivered secret's delivery receipt.
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from '../harness/test';
import { E2E_USER_EMAIL, E2E_USER_PASSWORD } from '../global-setup';
import { login, loginPasswordOnly, completeTwoFactor, modalByTestId, pickDateTime, fillCredentialItemCombobox, isLocalStackUp, syncAssetsUntilPopulated, pendingDashboardAction, openPendingDashboardRequest, openAdminTab } from '../helpers/ui';
import { provisionActorsAndTeams, provisionSystem, type ProvisionedScenario } from '../helpers/scenario';
import { submitWithCapture, submitRequestWithCapture, clickWithCapture, captureBefore, captureAfter, installCaptionOverlay, demoStep } from './helpers';
import { APP_PRIVATE_KEY_PEM_B64, APP_PUBLIC_KEY_PEM_B64 } from '../../../fixtures/aws-transport-keys';

const SUPERADMIN = { email: E2E_USER_EMAIL, password: E2E_USER_PASSWORD };
// Matches playwright.demo-secret-autorelease.config.ts, including isolated
// E2E_STACK_ID port shifts.
const E2E_BACKEND_URL = `http://localhost:${8791 + Number(process.env['E2E_STACK_ID'] ?? 0) * 10000}`;
const SYSTEM_SHORT_CODE = 'SARDEMO1';
const SYSTEM_NAME = 'Secret Autorelease Demo System';
const SR_NUMBER = 'SR-SARDEMO001';
// Matches infra/localstack/localstack-bootstrap.ts's fixed role name exactly — see
// addendum-043-asset-inventory-sync-e2e-and-demo-coverage.md.
const LOCALSTACK_ASSUME_ROLE_ARN = 'arn:aws:iam::000000000000:role/ffs-e2e-assume-role';

test.describe('demo showcase: LocalStack automated password release', () => {
  test('exchange preview -> approval -> live delivery -> client decrypt -> requester close', async ({ page, harness }) => {
    let scenario!: ProvisionedScenario;
    let keyFilePath = '';
    let requestNumber = '';

    await installCaptionOverlay(page);
    await page.goto('/');

    // Fails loudly rather than silently recording a "0 assets synced" demo —
    // see addendum-043-asset-inventory-sync-e2e-and-demo-coverage.md for why
    // this is a hard preflight check here instead of the Deno tests' silent
    // self-skip-when-unreachable convention.
    await demoStep(test, page, 'Setup — LocalStack reachability check for asset-inventory sync', async () => {
      const up = await isLocalStackUp(page);
      if (!up) {
        throw new Error(
          'LocalStack is not reachable at http://localhost:4566. Run `docker compose up -d` ' +
          'then `deno task localstack:bootstrap` before recording this demo.',
        );
      }
    });

    await demoStep(test, page, 'Setup — Actors, teams, and the demo system', async () => {
      scenario = await provisionActorsAndTeams(page, SUPERADMIN, 'sardemo');
      await provisionSystem(page, scenario, { shortCode: SYSTEM_SHORT_CODE, name: SYSTEM_NAME, awsRoleArnNote: LOCALSTACK_ASSUME_ROLE_ARN });
    });

    // Seed the app transport keypair into app_settings so the S3 asset-sync
    // route (resolveTransportKeys) can encrypt/decrypt the exchange envelope.
    // Runs after provisionActorsAndTeams (which leaves the page logged in as
    // SUPERADMIN) so the session token is available. The same fixed fixture
    // keys are used by localstack-bootstrap.ts and the Deno backend tests.
    await demoStep(test, page, 'Setup — AWS transport encryption keys', async () => {
      // Read the non-HttpOnly ffs_csrf cookie and fetch a fresh idempotency
      // token from capability-snapshot before each mutation.
      const csrfToken = await page.evaluate(() => {
        const match = document.cookie.match(/(?:^|;\s*)ffs_csrf=([^;]+)/);
        return match?.[1] ?? '';
      });
      for (const [key, value] of [
        ['aws_encrypt_private_key_pem_b64', APP_PRIVATE_KEY_PEM_B64],
        ['aws_encrypt_public_key_pem_b64', APP_PUBLIC_KEY_PEM_B64],
      ] as const) {
        const res = await page.evaluate(async ({ base, key, value, csrf }) => {
          const snap = await fetch(`${base}/me/capability-snapshot`, {
            credentials: 'include',
            headers: { 'X-CSRF-Token': csrf },
          }).then((r) => r.json());
          const r = await fetch(`${base}/admin/app-settings/${key}`, {
            method: 'PUT',
            credentials: 'include',
            headers: {
              'Content-Type': 'application/json',
              'X-CSRF-Token': csrf,
              'X-Idempotency-Token': snap.idempotencyToken,
            },
            body: JSON.stringify({ value }),
          });
          return r.status;
        }, { base: E2E_BACKEND_URL, key, value, csrf: csrfToken });
        expect(res).toBe(200);
      }
    });

    // A real S3 publish -> EventBridge -> Lambda -> S3 response round trip
    // against LocalStack (addendum-037/addendum-043) — the fake inventory
    // Lambda always returns two fixed assets (one password, one token type).
    await demoStep(test, page, "Setting up the demo: automatically discovering the system's asset inventory via a real S3 sync", async () => {
      await clickWithCapture(page, 'sardemo-open-assets-tab', page.getByTestId('admin-panel__tab-assets'));
      await page.getByTestId('admin-assets__system-select')
        .selectOption({ label: `${SYSTEM_SHORT_CODE} — ${SYSTEM_NAME}` });
      await syncAssetsUntilPopulated(page, 2);
      await expect(page.getByTestId('admin-assets__row')).toHaveCount(2);
    });

    // Feature the manual side of the Assets admin tab too — curates the
    // exact two (hostname, credential_name) pairs the vendor is about to
    // request below, so the later submission visibly matches known,
    // verified assets rather than arbitrary free text. These coexist
    // alongside the two system_managed rows the real sync above just added.
    await demoStep(test, page, "Setting up the demo: curating the system's asset inventory", async () => {
      const rowCountBefore = await page.getByTestId('admin-assets__row').count();

      await clickWithCapture(page, 'sardemo-assets-open-create-form', page.getByTestId('admin-assets__toggle-create-form-button'));
      await page.getByTestId('admin-assets__create-hostname-input').fill('host-sardemo-primary');
      await page.getByTestId('admin-assets__create-credential-name-input').fill('svc_sardemo_primary');
      await page.getByTestId('admin-assets__create-credential-type-select').selectOption('password');
      // waitForResponse avoids networkidle hang caused by pending LocalStack round-trips.
      await Promise.all([
        page.waitForResponse((r) => /\/admin\/systems\/.+\/assets$/.test(r.url()) && r.request().method() === 'POST'),
        page.getByTestId('admin-assets__create-submit-button').click(),
      ]);
      await expect(page.getByTestId('admin-assets__row')).toHaveCount(rowCountBefore + 1);

      await clickWithCapture(page, 'sardemo-assets-open-create-form-2', page.getByTestId('admin-assets__toggle-create-form-button'));
      await page.getByTestId('admin-assets__create-hostname-input').fill('host-sardemo-secondary');
      await page.getByTestId('admin-assets__create-credential-name-input').fill('svc_sardemo_secondary');
      await page.getByTestId('admin-assets__create-credential-type-select').selectOption('password');
      await Promise.all([
        page.waitForResponse((r) => /\/admin\/systems\/.+\/assets$/.test(r.url()) && r.request().method() === 'POST'),
        page.getByTestId('admin-assets__create-submit-button').click(),
      ]);
      await expect(page.getByTestId('admin-assets__row')).toHaveCount(rowCountBefore + 2);
    });

    await demoStep(test, page, 'Request — Requester first login, mandatory 2FA, submits with a client-generated RSA keypair', async () => {
      // First-ever login: the 2FA ENROLL gate is mandatory before submission
      // is reachable (addendum-046/047) — captured as its own feature moment.
      await loginPasswordOnly(page, scenario.vendorL1A.email, scenario.vendorL1A.password);
      await expect(page.getByTestId('two-factor-enroll')).toBeVisible();
      await expect(page.getByTestId('two-factor-enroll__qr-image')).toBeVisible();
      await captureBefore(page, 'sardemo-2fa-enroll');
      await completeTwoFactor(page, scenario.vendorL1A.email);
      await captureAfter(page, 'sardemo-2fa-enroll');

      await clickWithCapture(page, 'sardemo-view-dashboard-before-submit', page.getByTestId('vendor-dashboard__open-submit-button'));
      await page.getByTestId('vendor-dashboard__system-select')
        .selectOption({ label: `${SYSTEM_NAME} (${SYSTEM_SHORT_CODE})` });
      await page.getByTestId('vendor-dashboard__sr-number-input').fill(SR_NUMBER);
      await page.getByTestId('vendor-dashboard__justification-textarea')
        .fill('Production incident requiring emergency password access.');
      await pickDateTime(page, page.getByTestId('vendor-dashboard__activity-start-picker'), { hour: '00', minute: '00' });
      await pickDateTime(page, page.getByTestId('vendor-dashboard__activity-end-picker'), { hour: '23', minute: '59' });
      // Two Password-type items on the same request — demonstrates the
      // "one secret, multiple items" model: both will decrypt to the SAME
      // "TEST VALUE" but the popup lists each separately, labeled by its
      // own userid/hostname. See addendum-031's "one secret per request"
      // decision.
      await fillCredentialItemCombobox(page.getByTestId('vendor-dashboard__credential-item').first(), 'host-sardemo-primary', 'svc_sardemo_primary');
      await page.getByTestId('vendor-dashboard__add-credential-item-button').click();
      const secondItem = page.getByTestId('vendor-dashboard__credential-item').nth(1);
      await fillCredentialItemCombobox(secondItem, 'host-sardemo-secondary', 'svc_sardemo_secondary');
      // Variant B: the request's key is generated client-side and the wrapped
      // private-key file is MANDATORILY downloaded at submit — the file used
      // later to decrypt the delivered password.
      const [download, submitted] = await Promise.all([
        page.waitForEvent('download'),
        submitRequestWithCapture(page, 'sardemo-submit-request', page.getByTestId('vendor-dashboard__submit-request-button')),
      ]);
      requestNumber = submitted.requestNumber;
      const artifactPath = (await download.path()) as string;
      expect(artifactPath).toBeTruthy();
      expect(download.suggestedFilename()).toMatch(/private-key\.txt$/);
      // Copy to a stable location outside .playwright-artifacts-N/ — that
      // directory is cleaned up after setInputFiles() with inline content,
      // which causes ENOENT when the real key file is uploaded later.
      const stableDir = join(process.cwd(), 'test_output', 'e2e', 'demo', 'tmp');
      mkdirSync(stableDir, { recursive: true });
      keyFilePath = join(stableDir, `sardemo-key-${Date.now()}.tmp`);
      copyFileSync(artifactPath, keyFilePath);
    });

    await demoStep(test, page, 'Request — Vendor L2 approves step 1', async () => {
      await login(page, scenario.vendorL2A.email, scenario.vendorL2A.password);
      const approve = await pendingDashboardAction(page, requestNumber, 'vendor-dashboard__approve-button');
      await clickWithCapture(page, 'sardemo-vendor-l2-open-approve-modal', approve);
      const modal = modalByTestId(page, 'vendor-dashboard__action-modal');
      await submitWithCapture(page, 'sardemo-vendor-l2-approve', modal.getByTestId('vendor-dashboard__confirm-button'));
      await expect(modal).not.toBeVisible();
    });

    await demoStep(test, page, 'Request — Agency L1 approves step 2', async () => {
      await login(page, scenario.agencyL1A.email, scenario.agencyL1A.password);
      await clickWithCapture(page, 'sardemo-agency-l1-open-approve-modal', await pendingDashboardAction(page, requestNumber, 'agency-dashboard__approve-button'));
      const modal = modalByTestId(page, 'agency-dashboard__action-modal');
      await submitWithCapture(page, 'sardemo-agency-l1-approve', modal.getByTestId('agency-dashboard__confirm-button'));
      await expect(modal).not.toBeVisible();
    });

    await demoStep(test, page, 'Request — Agency L2 approves step 3, routes to owner', async () => {
      await login(page, scenario.agencyL2A.email, scenario.agencyL2A.password);
      await clickWithCapture(page, 'sardemo-agency-l2-open-approve-modal', await pendingDashboardAction(page, requestNumber, 'agency-dashboard__approve-button'));
      const modal = modalByTestId(page, 'agency-dashboard__action-modal');
      await submitWithCapture(page, 'sardemo-agency-l2-approve', modal.getByTestId('agency-dashboard__confirm-button'));
      await expect(modal).not.toBeVisible();
    });

    await demoStep(test, page, 'Request — Owner previews the automated exchange route, approves', async () => {
      await login(page, scenario.owner.email, scenario.owner.password);
      await openPendingDashboardRequest(page, requestNumber, 'owner-dashboard__view-button');
      await expect(page.getByTestId('request-detail__fulfillment-preview')).toBeVisible();
      await expect(page.getByTestId('request-detail__preview-exchange')).toContainText('svc_sardemo_primary');
      await expect(page.getByTestId('request-detail__preview-custody')).toHaveCount(0);
      await clickWithCapture(page, 'sardemo-owner-open-approve-modal', page.getByTestId('request-detail-view__owner-approve-button'));
      const modal = modalByTestId(page, 'request-detail-view__action-modal');
      await submitWithCapture(page, 'sardemo-owner-approve', modal.getByTestId('request-detail-view__confirm-button'));
      await expect(modal).not.toBeVisible();
      await expect(page.getByTestId('request-detail__fork-track-exchange')).toBeVisible();
    });

    // Delivery is asynchronous: the owner's approval only publishes the
    // request. GET /health prompts the centralized inbound sweep; once it has
    // reconciled the Lambda's response, the retrieve button becomes available.
    await demoStep(test, page, 'Delivery — Waiting for the password, GET /health prompts the sweep', async () => {
      await login(page, scenario.vendorL1A.email, scenario.vendorL1A.password);
      await (await pendingDashboardAction(page, requestNumber, 'vendor-dashboard__view-button')).click();
      await expect(page.getByTestId('request-detail-view__back-button')).toBeVisible();
      await expect(page.getByTestId('request-detail__fork-track-exchange')).toBeVisible();
      await expect(page.getByTestId('request-detail__fork-track-custody')).toHaveCount(0);
      for (let attempt = 0; attempt < 25; attempt++) {
        await page.request.get(`${E2E_BACKEND_URL}/health`);
        if ((await page.getByTestId('request-detail-view__retrieve-password-button').count()) > 0) break;
        await page.waitForTimeout(1000);
      }
      await expect(page.getByTestId('request-detail-view__retrieve-password-button')).toBeVisible();
      await expect(page.getByTestId('request-detail-view__close-request-button')).toBeVisible();
    });

    await demoStep(test, page, 'Audit — Requester reviews the approval and exchange timeline', async () => {
      // The audit disclosure is expanded by default — assert, then collapse
      // for the next recording beat.
      const auditDisclosure = page.getByTestId('request-detail-view__audit-disclosure');
      await expect(auditDisclosure).toHaveAttribute('open', '');
      await expect(auditDisclosure).toContainText('Audit timeline');
      await auditDisclosure.locator('summary').click();
    });

    // Feature the notification outbox: the live LocalStack delivery also
    // staged a normalized notification, receipt-tracked per channel — proof
    // the requester was told their credential arrived.
    await demoStep(test, page, 'Notifications — Admin tours the outbox, delivery receipt tracked', async () => {
      await login(page, SUPERADMIN.email, SUPERADMIN.password);
      await openAdminTab(page, 'sent-notifications', 'admin-sent-notifications__table');
      const deliveryRow = page.getByTestId('admin-sent-notifications__row')
        .filter({ hasText: 'request.aws_secret_delivery_received' }).first();
      await expect(deliveryRow).toBeVisible();
      await expect(deliveryRow.getByTestId('admin-sent-notifications__recipients-cell'))
        .toContainText(scenario.vendorL1A.email);
      await clickWithCapture(page, 'sardemo-outbox-open-detail', deliveryRow);
      const detail = modalByTestId(page, 'admin-sent-notifications__detail-modal');
      await expect(detail).toBeVisible();
      await expect(detail).toContainText('request.aws_secret_delivery_received');
      await clickWithCapture(page, 'sardemo-outbox-close-detail', detail.getByTestId('admin-sent-notifications__detail-close-button'));
      await expect(detail).not.toBeVisible();
    });

    // The requester opens Retrieve Password once and stays in it for both upload
    // attempts below — one deliberately-wrong file first, then the correct
    // key. The modal is opened here so the negative attempt and final success
    // share one continuous on-screen context.
    await demoStep(test, page, 'Retrieval — Requester opens Retrieve Password to decrypt', async () => {
      await login(page, scenario.vendorL1A.email, scenario.vendorL1A.password);
      await clickWithCapture(
        page, 'sardemo-requester-open-detail',
        await pendingDashboardAction(page, requestNumber, 'vendor-dashboard__view-button'),
        { waitForLocator: page.getByTestId('request-detail-view__back-button') },
      );
      await clickWithCapture(page, 'sardemo-open-retrieve-password', page.getByTestId('request-detail-view__retrieve-password-button'));
      await expect(modalByTestId(page, 'retrieve-password-modal')).toBeVisible();
    });

    // NEGATIVE TEST 1 — a completely wrong, irrelevant file (not even a key
    // envelope). unwrapPrivateKey() does JSON.parse(atob(...)) first, so a
    // random non-JSON blob throws immediately and the modal shows its error
    // banner. No decrypted value must ever appear.
    await demoStep(test, page, 'Retrieval — Negative test, wrong file rejected, no password revealed', async () => {
      const modal = modalByTestId(page, 'retrieve-password-modal');
      await modal.getByTestId('retrieve-password-modal__key-file-input').setInputFiles({
        name: 'holiday-itinerary.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('This is just some random text — definitely not an encrypted private key. 🏖️'),
      });
      await submitWithCapture(page, 'sardemo-decrypt-wrong-file', modal.getByTestId('retrieve-password-modal__decrypt-button'));
      // Error banner shown; no password revealed.
      await expect(modal.getByText('⚠', { exact: false })).toBeVisible();
      await expect(modal.getByTestId('retrieve-password-modal__decrypted-value')).toHaveCount(0);
    });

    await demoStep(test, page, 'Retrieval — Requester uploads their private key, decrypts locally in the browser', async () => {
      const modal = modalByTestId(page, 'retrieve-password-modal');
      await modal.getByTestId('retrieve-password-modal__key-file-input').setInputFiles(keyFilePath);
      await submitWithCapture(page, 'sardemo-decrypt-password', modal.getByTestId('retrieve-password-modal__decrypt-button'));
    });

    await demoStep(test, page, 'Retrieval — Both password items decrypted client-side, listed per credential', async () => {
      const modal = modalByTestId(page, 'retrieve-password-modal');
      const values = modal.getByTestId('retrieve-password-modal__decrypted-value');
      await expect(values).toHaveCount(2);
      await expect(values.nth(0)).toHaveText('TEST VALUE');
      await expect(values.nth(1)).toHaveText('TEST VALUE');
      await expect(modal.getByText('svc_sardemo_primary @ host-sardemo-primary')).toBeVisible();
      await expect(modal.getByText('svc_sardemo_secondary @ host-sardemo-secondary')).toBeVisible();
    });

    await demoStep(test, page, 'Retrieval — Requester closes the fulfilled request from the dialog', async () => {
      const modal = modalByTestId(page, 'retrieve-password-modal');
      await submitWithCapture(page, 'sardemo-close-fulfilled-request', modal.getByTestId('retrieve-password-modal__close-request-button'));
      await expect(modal).not.toBeVisible();
      await expect(page.getByText('Closed', { exact: true }).first()).toBeVisible();
      await expect(page.getByTestId('request-detail-view__audit-disclosure')).toBeVisible();
    });

    // Closing assurance beat: no React key/act warnings anywhere in the
    // recording — the addendum-193 console-hygiene bar, held on camera.
    await demoStep(test, page, 'Wrap-up — Console hygiene, warning-free recording', async () => {
      const noisy = harness.consoleLog()
        .filter((e) => e.type === 'error' || e.type === 'pageerror')
        .filter((e) => /unique "key" prop|not wrapped in act|Each child in a list|validateDOMNesting/i.test(e.text));
      expect(noisy, `console hygiene violations on camera: ${noisy.map((e) => e.text).join(' | ')}`).toEqual([]);
    });
  });
});
