// E2E coverage for the AWS integration's real (LocalStack-emulated)
// AssumeRole -> SSM discovery -> S3 PutObject round trip, AND the real
// EventBridge -> Lambda trigger that automatically produces the encrypted
// response. See addendum-035-localstack-aws-integration-testing.md and
// addendum-036-eventbridge-lambda-localstack-round-trip.md.
//
// NOT gated: unlike the original gated config (which hard-required LocalStack
// up and could not run otherwise), this spec self-skips gracefully when
// LocalStack is unreachable — mirroring the backend Deno suite
// (server/tests/aws-localstack.test.tsx). When LocalStack is up (`docker
// compose up -d` + `deno task localstack:bootstrap`) it runs the full real
// round trip; when it isn't, it skips with a clear reason instead of failing.
//
// Scope note: everything here is driven by real browser actions —
// AssumeRoleCommand + SSM GetParameter + PutObjectCommand fire for real
// against LocalStack when the owner approves, and the resulting object
// creation triggers a REAL EventBridge rule -> REAL (containerized) Lambda
// invocation entirely outside this app's control. Both the request object
// and the Lambda's response object are verified by fetching them directly
// from LocalStack's S3 endpoint (no AWS SDK needed — LocalStack serves
// objects over plain unsigned HTTP GET/PUT, confirmed empirically). The
// full publish -> sweep -> decrypt round trip (sweepTenantInboundDirectories)
// is driven by GET /health (addendum-09x), which always attempts the tenant
// inbound sweep asynchronously behind an in-process guard + Postgres advisory
// lock + throttle — no unsafe public "run all sweeps" endpoint. The Deno-level
// round trip (including the DB write to request_key_material) is covered in
// server/tests/aws-localstack.test.tsx, which can import and call
// sweepTenantChannel() directly; this browser spec verifies the S3 artifacts
// the real AssumeRole/Lambda pipeline produces.
//
// The final step also drives the Assets tab's "Sync Now" button (a real,
// independent S3 request/response exchange for asset-inventory
// interrogation, addendum-037-asset-inventory.md) — this is admin-triggered
// on demand, not cron-only, so an HTTP route already exists and a real
// browser-driven test is safe/appropriate here. See
// addendum-043-asset-inventory-sync-e2e-and-demo-coverage.md.
import { test, expect } from '../helpers/harness';
import { E2E_USER_EMAIL, E2E_USER_PASSWORD } from '../global-setup';
import { login, rowButton, modalByTestId, pickDateTime, submitWithCapture, submitRequestWithCapture, createAssetViaAdminUI, fillCredentialItemCombobox, syncAssetsUntilPopulated, isLocalStackUp, confirmDecisionAndWait,} from '../helpers/ui';
import { provisionActorsAndTeams, provisionSystem, type ProvisionedScenario } from '../helpers/scenario';

const SUPERADMIN = { email: E2E_USER_EMAIL, password: E2E_USER_PASSWORD };
const E2E_BACKEND_URL = process.env['E2E_BACKEND_URL'] ?? `http://localhost:${8792 + Number(process.env['E2E_STACK_ID'] ?? 0) * 10000}`;
const LOCALSTACK_ENDPOINT = process.env['AWS_ENDPOINT_URL'] ?? `http://localhost:${4566 + Number(process.env['E2E_STACK_ID'] ?? 0) * 10000}`;
const ASSUME_ROLE_ARN = 'arn:aws:iam::000000000000:role/ffs-e2e-assume-role';
// Matches infra/localstack/localstack-bootstrap.ts's fixed names exactly.
const BUCKET = 'ffs-e2e-bucket';
const FOLDER_PREFIX = 'exchange';

// Section N: GET /health always attempts the tenant inbound sweep asynchronously
// (in-process guard + advisory lock + throttle), so browser-driven tests prompt
// async S3 exchange processing by hitting it — no public "run all sweeps" route.
async function triggerHealth(page: any): Promise<void> {
  await page.request.get(`${E2E_BACKEND_URL}/health`);
}


// No-longer-gated self-skip: if LocalStack is unreachable, skip the whole
// suite with a clear reason instead of failing (mirrors the backend Deno
// suite). Call at the top of each test.
async function skipIfLocalStackDown(page: any): Promise<void> {
  if (!(await isLocalStackUp(page))) {
    test.skip(true, 'LocalStack not reachable at http://localhost:4566 — run `docker compose up -d` and `deno task localstack:bootstrap` to enable.');
  }
}

test.describe('aws localstack integration', () => {
  test('owner approval triggers a real AssumeRole + S3 publish against LocalStack', async ({ page }) => {
    await skipIfLocalStackDown(page);
    let scenario!: ProvisionedScenario;
    let requestId = '';
    let keyFilePath = '';

    await test.step('provision the actor/team roster and a system pointed at the LocalStack role', async () => {
      scenario = await provisionActorsAndTeams(page, SUPERADMIN, 'awsls');
      await login(page, SUPERADMIN.email, SUPERADMIN.password);
      await provisionSystem(page, scenario, { shortCode: 'ALS1', name: 'AWS LocalStack Test System' });

      // aws_role_arn_note has no dedicated UI test-id path exercised
      // elsewhere for e2e — set it via the real admin update route from
      // within the page's own session, the same test-harness-only setup
      // pattern the other specs use for values with no natural UI flow.
      const session = await page.evaluate(() => localStorage.getItem('session'));
      const systemsRes = await page.evaluate(async ({ base, session }) => {
        const res = await fetch(`${base}/admin/systems`, { headers: { 'X-Session-Token': session! } });
        return res.json();
      }, { base: E2E_BACKEND_URL, session });
      const system = systemsRes.systems.find((s: any) => s.shortCode === 'ALS1');

      const snap = await page.evaluate(async ({ base, session }) => {
        const res = await fetch(`${base}/me/capability-snapshot`, { headers: { 'X-Session-Token': session! } });
        return res.json();
      }, { base: E2E_BACKEND_URL, session });

      const updateStatus = await page.evaluate(async ({ base, session, systemId, roleArn, token }) => {
        const res = await fetch(`${base}/admin/systems/${systemId}`, {
          method: 'PUT',
          headers: { 'X-Session-Token': session!, 'Content-Type': 'application/json', 'X-Idempotency-Token': token },
          body: JSON.stringify({ awsRoleArnNote: roleArn }),
        });
        return res.status;
      }, { base: E2E_BACKEND_URL, session, systemId: system.id, roleArn: ASSUME_ROLE_ARN, token: snap.idempotencyToken });
      expect(updateStatus).toBe(200);

      // Per addendum-039-asset-gated-submission.md.
      await createAssetViaAdminUI(page, {
        systemLabel: 'ALS1 — AWS LocalStack Test System', hostname: 'host-als', credentialName: 'svc_als', credentialType: 'password', navigateFirst: true,
      });
    });

    await test.step('vendor L1 submits a Password-type request', async () => {
      await login(page, scenario.vendorL1A.email, scenario.vendorL1A.password);
      await page.getByTestId('vendor-dashboard__open-submit-button').click();
      await page.getByTestId('vendor-dashboard__system-select').selectOption({ label: 'AWS LocalStack Test System (ALS1)' });
      await page.getByTestId('vendor-dashboard__sr-number-input').fill('SR-ALS001');
      await page.getByTestId('vendor-dashboard__justification-textarea').fill('Production incident requiring emergency password access.');
      // Full-day window so "now" always falls inside it, regardless of when this test runs.
      await pickDateTime(page, page.getByTestId('vendor-dashboard__activity-start-picker'), { hour: '00', minute: '00' });
      await pickDateTime(page, page.getByTestId('vendor-dashboard__activity-end-picker'), { hour: '23', minute: '59' });
      await fillCredentialItemCombobox(page.getByTestId('vendor-dashboard__credential-item'), 'host-als', 'svc_als');
      // Variant B: the request's key is generated client-side and the wrapped
      // private-key file is MANDATORILY downloaded at submit — the file used
      // later to decrypt the delivered password.
      const [download] = await Promise.all([
        page.waitForEvent('download'),
        (async () => {
          requestId = await submitRequestWithCapture(page, 'aws-localstack-submit', page.getByTestId('vendor-dashboard__submit-request-button'));
        })(),
      ]);
      expect(requestId).toBeTruthy();
      keyFilePath = (await download.path()) as string;
      expect(keyFilePath).toBeTruthy();
      expect(download.suggestedFilename()).toMatch(/private-key\.txt$/);
    });

    await test.step('the request is carried through approval to the owner terminal', async () => {
      await login(page, scenario.vendorL2A.email, scenario.vendorL2A.password);
      await rowButton(page, 'AWS LocalStack Test System', 'vendor-dashboard__view-button').click();
      await page.getByTestId('request-detail-view__step-approve-button').click();
      let modal = modalByTestId(page, 'request-detail-view__action-modal');
      await modal.getByTestId('request-detail-view__confirm-button').click();
      await expect(modal).not.toBeVisible();

      await login(page, scenario.agencyL1A.email, scenario.agencyL1A.password);
      await rowButton(page, 'AWS LocalStack Test System', 'agency-dashboard__approve-button').click();
      modal = modalByTestId(page, 'agency-dashboard__action-modal');
      await confirmDecisionAndWait(page, await modal.getByTestId('agency-dashboard__confirm-button'));
      await expect(modal).not.toBeVisible();

      await login(page, scenario.agencyL2A.email, scenario.agencyL2A.password);
      await rowButton(page, 'AWS LocalStack Test System', 'agency-dashboard__approve-button').click();
      modal = modalByTestId(page, 'agency-dashboard__action-modal');
      await confirmDecisionAndWait(page, await modal.getByTestId('agency-dashboard__confirm-button'));
      await expect(modal).not.toBeVisible();
    });

    await test.step('owner approves — the real AssumeRole + S3 publish fires against LocalStack', async () => {
      await login(page, scenario.owner.email, scenario.owner.password);
      await rowButton(page, 'AWS LocalStack Test System', 'owner-dashboard__approve-button').click();
      const modal = modalByTestId(page, 'owner-dashboard__action-modal');
      await submitWithCapture(page, 'aws-localstack-owner-approve', modal.getByTestId('owner-dashboard__confirm-button'));
      await expect(modal).not.toBeVisible();
    });

    await test.step('a real request object exists in LocalStack S3 — fetched directly, outside the app', async () => {
      // LocalStack serves S3 objects over plain unsigned HTTP GET — no AWS
      // SDK needed to verify from here (confirmed empirically). This proves
      // the owner-approval hook's assumeSystemRoleAndResolveDelivery() +
      // PutObjectCommand actually executed against a real (emulated) AWS
      // API, not merely that the app's own DB/UI state looks right.
      let published: any = null;
      const publishedKey = `${FOLDER_PREFIX}/v1/outbound/credential-request/${requestId}.json`;
      for (let attempt = 0; attempt < 10 && !published; attempt++) {
        const res = await page.request.get(`${LOCALSTACK_ENDPOINT}/${BUCKET}/${publishedKey}`);
        if (res.ok()) {
          published = await res.json();
        } else {
          await page.waitForTimeout(500);
        }
      }
      expect(published).not.toBeNull();
      expect(published.requestId).toBe(requestId);
      expect(published.awsRoleArnNote).toBe(ASSUME_ROLE_ARN);
    });

    await test.step('the real EventBridge rule triggers a real Lambda, which writes a response object', async () => {
      // Nothing in this app or spec simulates the Lambda's write — the
      // PutObjectCommand from the prior step is what triggered LocalStack's
      // real EventBridge rule -> real (containerized) Lambda invocation,
      // entirely outside this app's control. Polling here rather than a
      // fixed sleep, since LocalStack Lambda cold start + event propagation
      // takes a few real seconds.
      let responded: any = null;
      const respondedKey = `${FOLDER_PREFIX}/v1/inbound/credential-response/${requestId}.json`;
      for (let attempt = 0; attempt < 20 && !responded; attempt++) {
        const res = await page.request.get(`${LOCALSTACK_ENDPOINT}/${BUCKET}/${respondedKey}`);
        if (res.ok()) {
          responded = await res.json();
        } else {
          await page.waitForTimeout(1000);
        }
      }
      expect(responded, 'expected the real EventBridge-triggered Lambda to have produced a response within the retry budget').not.toBeNull();
      expect(responded.requestId).toBe(requestId);
      expect(responded.status).toBe('success');
      expect(responded.encryptedPayload).toBeTruthy();
    });

    await test.step('/health prompts the centralized inbound sweep to process the credential response', async () => {
      // Section N credential user story: the real v1 response object has been
      // written by the Lambda; GET /health then prompts the app's centralized
      // inbound sweep, which lists the channel's v1/inbound directory, matches
      // the awaiting credential_request exchange, and reconciles the encrypted
      // secret into request_key_material. That reconcile writes the
      // request.aws_secret_delivery_received audit event, which surfaces in the
      // Request Detail audit timeline — asserted here as the browser-visible
      // outcome of the /health-triggered sweep.
      await login(page, scenario.vendorL1A.email, scenario.vendorL1A.password);
      for (let attempt = 0; attempt < 20; attempt++) {
        await rowButton(page, 'AWS LocalStack Test System', 'vendor-dashboard__view-button').click();
        await expect(page.getByTestId('request-detail-view__back-button')).toBeVisible();
        const list = page.getByTestId('request-detail-view__list');
        if ((await list.getByText(/Aws Secret Delivery Received/i).count()) > 0) break;
        await triggerHealth(page);
        await page.waitForTimeout(1000);
      }
      await expect(page.getByTestId('request-detail-view__list')).toContainText(/Aws Secret Delivery Received/i);
    });

    await test.step('the original requester retrieves and decrypts the password through the UI', async () => {
      // Now that the sweep has delivered the real encrypted payload, the
      // submitter uploads the private-key file they were forced to download at
      // submit, and the modal decrypts to the tenant's delivered value
      // ("TEST VALUE", the LocalStack Lambda's Secrets Manager secret) using
      // the server-provided private_key_wrap_key.
      await login(page, scenario.vendorL1A.email, scenario.vendorL1A.password);
      await rowButton(page, 'AWS LocalStack Test System', 'vendor-dashboard__view-button').click();
      await expect(page.getByTestId('request-detail-view__back-button')).toBeVisible();

      // The button is now active because the AWS response has landed — the
      // wrap-key retrieval API must now succeed (200) and yield the wrap key,
      // which the earlier 403/409 gaps would not have.
      const material = await page.evaluate(async ({ base, id }) => {
        const res = await fetch(`${base}/requests/${id}/secret-material`, { credentials: 'include' });
        return { status: res.status, body: await res.json() };
      }, { base: E2E_BACKEND_URL, id: requestId });
      expect(material.status).toBe(200);
      expect(material.body.privateKeyWrapKey).toBeTruthy();

      await page.getByTestId('request-detail-view__retrieve-password-button').click();
      const modal = modalByTestId(page, 'retrieve-password-modal');
      await expect(modal).toBeVisible();

      await modal.getByTestId('retrieve-password-modal__key-file-input').setInputFiles(keyFilePath);
      await modal.getByTestId('retrieve-password-modal__decrypt-button').click();
      await expect(modal.getByTestId('retrieve-password-modal__decrypted-value')).toHaveText('TEST VALUE');
      await modal.getByTestId('retrieve-password-modal__cancel-button').click();
      await expect(modal).not.toBeVisible();
    });

    await test.step('admin clicks Sync Now on the Assets tab — a real second exchange, independent request/response prefixes', async () => {
      // Closes the browser-driven coverage gap addendum-037 explicitly
      // flagged as untested ("does not add a browser-driven e2e spec for
      // the 'admin clicks Sync Now' flow") — see
      // addendum-043-asset-inventory-sync-e2e-and-demo-coverage.md. This
      // reuses the same ALS1 system provisioned above (already has
      // aws_role_arn_note set to the LocalStack role), driving the real
      // Assets tab sync button rather than calling
      // syncAssetInventoryForSystem() directly the way
      // server/tests/aws-asset-inventory.test.tsx does.
      await login(page, SUPERADMIN.email, SUPERADMIN.password);
      await page.getByTestId('admin-panel__tab-assets').click();
      await Promise.all([
        page.waitForResponse((res) => /\/admin\/systems\/.+\/assets$/.test(res.url()) && res.request().method() === 'GET'),
        page.getByTestId('admin-assets__system-select').selectOption({ label: 'ALS1 — AWS LocalStack Test System' }),
      ]);
      const rowCountBefore = await page.getByTestId('admin-assets__row').count();

      await syncAssetsUntilPopulated(page, rowCountBefore + 2);
      await expect(page.getByTestId('admin-assets__row')).toHaveCount(rowCountBefore + 2);

      // Matches setup/localstack-lambda-inventory/index.mjs's fixed
      // FAKE_ASSETS array exactly — one password, one token.
      const hostnames = await page.getByTestId('admin-assets__hostname-input').evaluateAll(
        (inputs) => inputs.map((el) => (el as HTMLInputElement).value),
      );
      expect(hostnames).toContain('host-inventory-01');
      expect(hostnames).toContain('host-inventory-02');
    });
  });

  test('close acknowledgement user story: close via Request Detail, /health prompts the sweep to record the tenant ack, request stays closed', async ({ page }) => {
    await skipIfLocalStackDown(page);
    let scenario!: ProvisionedScenario;
    let requestId = '';

    await test.step('provision a system pointed at the LocalStack role with one password asset', async () => {
      scenario = await provisionActorsAndTeams(page, SUPERADMIN, 'awsls2');
      await login(page, SUPERADMIN.email, SUPERADMIN.password);
      await provisionSystem(page, scenario, { shortCode: 'ALS2', name: 'AWS LocalStack Close Ack System', awsRoleArnNote: ASSUME_ROLE_ARN });
      await createAssetViaAdminUI(page, {
        systemLabel: 'ALS2 — AWS LocalStack Close Ack System', hostname: 'host-als2', credentialName: 'svc_als2', credentialType: 'password', navigateFirst: true,
      });
    });

    await test.step('vendor submits and the request is approved through the UI (real publish fires on owner approve)', async () => {
      await login(page, scenario.vendorL1A.email, scenario.vendorL1A.password);
      await page.getByTestId('vendor-dashboard__open-submit-button').click();
      await page.getByTestId('vendor-dashboard__system-select').selectOption({ label: 'AWS LocalStack Close Ack System (ALS2)' });
      await page.getByTestId('vendor-dashboard__sr-number-input').fill('SR-ALS002');
      await page.getByTestId('vendor-dashboard__justification-textarea').fill('Production incident requiring emergency password access.');
      await pickDateTime(page, page.getByTestId('vendor-dashboard__activity-start-picker'), { hour: '00', minute: '00' });
      await pickDateTime(page, page.getByTestId('vendor-dashboard__activity-end-picker'), { hour: '23', minute: '59' });
      await fillCredentialItemCombobox(page.getByTestId('vendor-dashboard__credential-item'), 'host-als2', 'svc_als2');
      requestId = await submitRequestWithCapture(page, 'aws-localstack-close-submit', page.getByTestId('vendor-dashboard__submit-request-button'));
      expect(requestId).toBeTruthy();

      await login(page, scenario.vendorL2A.email, scenario.vendorL2A.password);
      await rowButton(page, 'AWS LocalStack Close Ack System', 'vendor-dashboard__view-button').click();
      await page.getByTestId('request-detail-view__step-approve-button').click();
      let modal = modalByTestId(page, 'request-detail-view__action-modal');
      await modal.getByTestId('request-detail-view__confirm-button').click();
      await expect(modal).not.toBeVisible();

      await login(page, scenario.agencyL1A.email, scenario.agencyL1A.password);
      await rowButton(page, 'AWS LocalStack Close Ack System', 'agency-dashboard__approve-button').click();
      modal = modalByTestId(page, 'agency-dashboard__action-modal');
      await confirmDecisionAndWait(page, await modal.getByTestId('agency-dashboard__confirm-button'));
      await expect(modal).not.toBeVisible();

      await login(page, scenario.agencyL2A.email, scenario.agencyL2A.password);
      await rowButton(page, 'AWS LocalStack Close Ack System', 'agency-dashboard__approve-button').click();
      modal = modalByTestId(page, 'agency-dashboard__action-modal');
      await confirmDecisionAndWait(page, await modal.getByTestId('agency-dashboard__confirm-button'));
      await expect(modal).not.toBeVisible();

      await login(page, scenario.owner.email, scenario.owner.password);
      await rowButton(page, 'AWS LocalStack Close Ack System', 'owner-dashboard__approve-button').click();
      modal = modalByTestId(page, 'owner-dashboard__action-modal');
      await submitWithCapture(page, 'aws-localstack-close-owner-approve', modal.getByTestId('owner-dashboard__confirm-button'));
      await expect(modal).not.toBeVisible();
    });

    await test.step('agency L1 issues the credential then closes the request via the dashboard', async () => {
      await login(page, scenario.agencyL1A.email, scenario.agencyL1A.password);
      await rowButton(page, 'AWS LocalStack Close Ack System', 'agency-dashboard__issue-button').click();
      let modal = modalByTestId(page, 'agency-dashboard__action-modal');
      await confirmDecisionAndWait(page, await modal.getByTestId('agency-dashboard__confirm-button'));
      await expect(modal).not.toBeVisible();

      await rowButton(page, 'AWS LocalStack Close Ack System', 'agency-dashboard__close-button').click();
      modal = modalByTestId(page, 'agency-dashboard__action-modal');
      await confirmDecisionAndWait(page, await modal.getByTestId('agency-dashboard__confirm-button'));
      await expect(modal).not.toBeVisible();
    });

    await test.step('the request is locally closed', async () => {
      await login(page, scenario.vendorL1A.email, scenario.vendorL1A.password);
      await expect(page.locator('tr', { hasText: 'AWS LocalStack Close Ack System' })).toContainText(/closed/i);
    });

    await test.step('/health prompts the sweep to record the tenant close acknowledgement; request remains closed', async () => {
      // The close publish (request-close outbound) triggered the real Lambda,
      // which wrote a v1/inbound/request-close-ack object. /health then prompts
      // the centralized sweep to process it (records the request.aws_close_
      // acknowledged audit event). Poll the Request Detail audit timeline for
      // that ack, re-triggering /health until it lands.
      await login(page, scenario.vendorL1A.email, scenario.vendorL1A.password);
      for (let attempt = 0; attempt < 20; attempt++) {
        await rowButton(page, 'AWS LocalStack Close Ack System', 'vendor-dashboard__view-button').click();
        await expect(page.getByTestId('request-detail-view__back-button')).toBeVisible();
        const list = page.getByTestId('request-detail-view__list');
        if ((await list.getByText(/Aws Close Acknowledged/i).count()) > 0) break;
        await triggerHealth(page);
        await page.waitForTimeout(1000);
      }
      await expect(page.getByTestId('request-detail-view__list')).toContainText(/Aws Close Acknowledged/i);
      // The local request closure is final regardless of the ack.
      await expect(page.getByText(/closed/i).first()).toBeVisible();
    });
  });

  test('inventory sync user story: Sync Now + /health reconciles the tenant inventory; vendor sees reconciled assets selectable', async ({ page }) => {
    await skipIfLocalStackDown(page);
    let scenario!: ProvisionedScenario;

    await test.step('provision a system pointed at the LocalStack role (no manual assets — sync creates system-managed rows)', async () => {
      scenario = await provisionActorsAndTeams(page, SUPERADMIN, 'awsls3');
      await login(page, SUPERADMIN.email, SUPERADMIN.password);
      await provisionSystem(page, scenario, { shortCode: 'ALS3', name: 'AWS LocalStack Inventory System', awsRoleArnNote: ASSUME_ROLE_ARN });
    });

    await test.step('admin clicks Sync Now once (publishes the v1 inventory request)', async () => {
      await login(page, SUPERADMIN.email, SUPERADMIN.password);
      await page.getByTestId('admin-panel__tab-assets').click();
      await Promise.all([
        page.waitForResponse((res) => /\/admin\/systems\/.+\/assets$/.test(res.url()) && res.request().method() === 'GET'),
        page.getByTestId('admin-assets__system-select').selectOption({ label: 'ALS3 — AWS LocalStack Inventory System' }),
      ]);
      const [syncRes] = await Promise.all([
        page.waitForResponse((res) => /\/admin\/systems\/.+\/assets\/sync$/.test(res.url()) && res.request().method() === 'POST'),
        page.getByTestId('admin-assets__sync-button').click(),
      ]);
      expect(syncRes.status()).toBe(200);
    });

    await test.step('/health prompts the sweep to reconcile the inventory response into the assets table', async () => {
      // Matches setup/localstack-lambda-inventory/index.mjs's fixed FAKE_ASSETS.
      for (let attempt = 0; attempt < 20; attempt++) {
        await triggerHealth(page);
        // Force a fresh GET by toggling the system selection (empty -> target);
        // re-selecting the same option would not fire a change event.
        await page.getByTestId('admin-assets__system-select').selectOption('');
        await Promise.all([
          page.waitForResponse((res) => /\/admin\/systems\/.+\/assets$/.test(res.url()) && res.request().method() === 'GET'),
          page.getByTestId('admin-assets__system-select').selectOption({ label: 'ALS3 — AWS LocalStack Inventory System' }),
        ]);
        const hostnames = await page.getByTestId('admin-assets__hostname-input').evaluateAll(
          (inputs) => inputs.map((el) => (el as HTMLInputElement).value),
        );
        if (hostnames.includes('host-inventory-01') && hostnames.includes('host-inventory-02')) {
          expect(hostnames).toContain('host-inventory-01');
          expect(hostnames).toContain('host-inventory-02');
          return;
        }
        await page.waitForTimeout(1000);
      }
      throw new Error('Inventory sync did not reconcile host-inventory-01/02 after /health-triggered sweeps.');
    });

    await test.step('vendor can select the reconciled assets in the request form', async () => {
      await login(page, scenario.vendorL1A.email, scenario.vendorL1A.password);
      await page.getByTestId('vendor-dashboard__open-submit-button').click();
      await page.getByTestId('vendor-dashboard__system-select').selectOption({ label: 'AWS LocalStack Inventory System (ALS3)' });
      await fillCredentialItemCombobox(page.getByTestId('vendor-dashboard__credential-item'), 'host-inventory-01', 'svc_inventory_01');
      const itemRow = page.getByTestId('vendor-dashboard__credential-item');
      await expect(itemRow.getByTestId('vendor-dashboard__credential-hostname-combobox')).toContainText('host-inventory-01');
      await expect(itemRow.getByTestId('vendor-dashboard__credential-name-combobox')).toContainText('svc_inventory_01');
    });
  });
});
