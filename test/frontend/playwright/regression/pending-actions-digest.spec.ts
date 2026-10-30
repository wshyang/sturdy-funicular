// Q11 daily-digest opt-in toggle + end-to-end digest delivery (addendum-131
// for the feature; addendum-195 for THIS suite and the /health prompt it
// drives).
//
// The dashboard checkbox (PendingActionsDigestToggle, mounted on every
// custody-aware dashboard) previously had only jsdom component suites and a
// Deno backend suite — the full e2e loop was untestable because the digest
// only fired on a Deno.cron schedule (default 00:15 UTC daily). Addendum-195
// adds the addendum-107-style /health prompt (maybeTriggerPendingActionsDigest
// → runJobWithGuards — the SAME guarded executor the cron registration
// uses), so this suite can drive the real loop inside one test.
// Addendum-197 anchors due-ness to the app-settings send TIME, so test 1
// additionally pins that setting to 00:00 UTC (and restores it) to stay
// time-of-day independent:
//
//   test 1 (positive): vendor L1 submits a break-glass request → vendor L2 A
//     (a current-step reviewer — somebody who genuinely owes an action)
//     checks the toggle on their OWN dashboard → PUT persists past a reload →
//     /health prompts the daily fan-out → exactly one
//     'pending_actions.daily_digest' row lands in the admin Sent-
//     Notifications outbox, addressed to that reviewer, naming the request
//     number and carrying the derivation's own cue + per-request direct link.
//     The row's detail modal opens from the outbox (click) and closes.
//   test 2 (negative twin — screenshot parity requires an even per-spec
//     delta): a fresh scenario where the owing reviewer leaves the toggle
//     OFF; the same /health prompts stage NOTHING for them. Default-off is
//     asserted on the checkbox itself (the opt-IN contract), and the outbox
//     API + tab both show zero digest rows for that recipient.
//
// Both tests navigate the request through the actors' PENDING DASHBOARDS
// only (addendum-178): the reviewer never searches globally. The outbox
// API poll (fetchOutboxMatchCount) is the standard e2e escape hatch for
// awaiting an asynchronous backend job — the same page-evaluate fetch shape
// as directGetRequestStatus/directFetchStatus in helpers/ui.ts — and the
// visible Surfaces-Under-Test assertions all happen on the real outbox tab.
import { test, expect } from '../helpers/harness';
import type { Page } from '@playwright/test';
import { E2E_USER_EMAIL, E2E_USER_PASSWORD } from '../global-setup';
import {
  login, modalByTestId, pickDateTime, createAssetViaAdminUI, clickWithCapture,
  fillCredentialItemCombobox, submitRequestIdentityWithCapture, getSessionCookie,
  pendingDashboardAction, openAdminTab,
} from '../helpers/ui';
import { openSentNotificationsTab } from '../helpers/direct-link';
import { provisionActorsAndTeams, provisionSystem, type ProvisionedScenario } from '../helpers/scenario';

const SUPERADMIN = { email: E2E_USER_EMAIL, password: E2E_USER_PASSWORD };

const E2E_BACKEND_URL = process.env['E2E_BACKEND_URL'] ??
  `http://localhost:${8789 + Number(process.env['E2E_STACK_ID'] ?? 0) * 10000}`;

const DIGEST_TRIGGER_KEY = 'pending_actions.daily_digest';

// GET /health fire-and-forget prompt for the digest job — identical shape to
// the tenant-inbound-sweep prompt in aws-localstack.spec.ts (addendum-107).
async function promptDigestViaHealth(page: Page): Promise<void> {
  const res = await page.request.get(`${E2E_BACKEND_URL}/health`);
  expect(res.status(), 'a health probe prompting the digest still answers 200').toBe(200);
}

const DIGEST_SCHEDULE_SETTING = 'cron_pending_actions_digest';

// Addendum-197: a user is due only once NOW is at/past TODAY's send instant
// (parsed from this app setting, a strictly-daily "m h * * *" UTC schedule).
// The suite pins the send time to 00:00 UTC for the duration of the positive
// test — already past at any time of day — and restores the stack's original
// schedule afterwards, so the e2e is time-of-day independent and leaks no
// settings drift into sibling specs sharing the stack.
async function readDigestSchedule(page: Page): Promise<string> {
  const session = await getSessionCookie(page);
  const res = await page.request.get(`${E2E_BACKEND_URL}/admin/app-settings`, {
    headers: session ? { 'X-Session-Token': session } : {},
  });
  expect(res.status(), 'reading app settings succeeds for the superadmin').toBe(200);
  const body = await res.json() as { settings: Array<{ key: string; value: string }> };
  const row = body.settings.find((s) => s.key === DIGEST_SCHEDULE_SETTING);
  expect(row, 'the digest schedule setting is seeded').toBeTruthy();
  return row!.value;
}

async function writeDigestSchedule(page: Page, value: string): Promise<void> {
  const session = await getSessionCookie(page);
  const sessionHeaders: Record<string, string> = session ? { 'X-Session-Token': session } : {};
  // Mutating routes require a fresh idempotency token (addendum-008) —
  // /me/capability-snapshot mints one, same as the frontend client.
  const snap = await page.request.get(`${E2E_BACKEND_URL}/me/capability-snapshot`, { headers: sessionHeaders });
  const { idempotencyToken } = await snap.json() as { idempotencyToken: string };
  // page.request sends the browser's cookies automatically. The server's CSRF
  // middleware fires for PUT when a session cookie is present (double-submit
  // check). Extract the CSRF cookie and echo it back as X-CSRF-Token.
  const allCookies = await page.context().cookies();
  const csrfCookie = allCookies.find((c) => c.name === 'ffs_csrf' || c.name === '__Host-ffs_csrf');
  const csrfHeaders: Record<string, string> = csrfCookie ? { 'X-CSRF-Token': csrfCookie.value } : {};
  const res = await page.request.put(`${E2E_BACKEND_URL}/admin/app-settings/${DIGEST_SCHEDULE_SETTING}`, {
    headers: { ...sessionHeaders, ...csrfHeaders, 'X-Idempotency-Token': idempotencyToken },
    data: { value },
  });
  expect(res.status(), `setting ${DIGEST_SCHEDULE_SETTING}=${JSON.stringify(value)} succeeds`).toBe(200);
}

// Counts staged digest notifications addressed to `email` via the admin
// outbox API, using the PAGE's current superadmin session (the dual-path
// X-Session-Token header, same as helpers/ui.ts's directFetchStatus).
// Polling this endpoint is how the test awaits the asynchronous
// fire-and-forget job without ever scraping /health for a status that route
// deliberately does not expose.
async function fetchOutboxMatchCount(page: Page, email: string): Promise<number> {
  const session = await getSessionCookie(page);
  return page.evaluate(async ({ base, token, trigger, recipient }) => {
    const res = await fetch(`${base}/admin/sent-notifications`, {
      headers: token ? { 'X-Session-Token': token } : {},
    });
    if (!res.ok) return -1;
    const body = await res.json() as {
      notifications: Array<{
        triggerKey: string;
        recipients?: Array<{ emailSnapshot?: string }>;
      }>;
    };
    return body.notifications.filter((n) =>
      n.triggerKey === trigger &&
      (n.recipients ?? []).some((r) => (r.emailSnapshot ?? '') === recipient)
    ).length;
  }, { base: E2E_BACKEND_URL, token: session, trigger: DIGEST_TRIGGER_KEY, recipient: email });
}

// Polls /health (re-arming the prompter past its min-interval) until the
// outbox holds `wanted` digest rows for `email` or the budget runs out.
async function pollOutboxCount(
  page: Page,
  email: string,
  wanted: number,
  message: string,
): Promise<void> {
  let last = -1;
  for (let attempt = 0; attempt < 20; attempt++) {
    await promptDigestViaHealth(page);
    await page.waitForTimeout(500);
    last = await fetchOutboxMatchCount(page, email);
    if (last === wanted) return;
  }
  expect(last, message).toBe(wanted);
}

// Shared provisioning: actors/teams (tag-suffixed), a wired 3-step system,
// one asset, and one break-glass request submitted by vendor L1 A — which
// leaves the request pending at vendor L2, so BOTH vendor-L2 members owe the
// review (the digest's derivation precondition in each test).
async function provisionOwedRequest(
  page: Page,
  tag: string,
  shortCode: string,
  systemName: string,
): Promise<{ scenario: ProvisionedScenario; requestNumber: string }> {
  const scenario = await provisionActorsAndTeams(page, SUPERADMIN, tag);
  await provisionSystem(page, scenario, { shortCode, name: systemName });
  await createAssetViaAdminUI(page, {
    systemLabel: `${shortCode} — ${systemName}`,
    hostname: `digest-${tag}.prod.internal`,
    credentialName: `digest-${tag}-token`,
    credentialType: 'token',
    navigateFirst: true,
  });

  await login(page, scenario.vendorL1A.email, scenario.vendorL1A.password);
  await page.getByTestId('vendor-dashboard__open-submit-button').click();
  await page.getByTestId('vendor-dashboard__system-select')
    .selectOption({ label: `${systemName} (${shortCode})` });
  await page.getByTestId('vendor-dashboard__sr-number-input').fill(`SR-DIG-${tag.toUpperCase()}`);
  await page.getByTestId('vendor-dashboard__justification-textarea')
    .fill('Digest e2e: production incident requiring emergency database access.');
  await pickDateTime(page, page.getByTestId('vendor-dashboard__activity-start-picker'), { hour: '09', minute: '00' });
  await pickDateTime(page, page.getByTestId('vendor-dashboard__activity-end-picker'), { hour: '17', minute: '00' });
  await fillCredentialItemCombobox(
    page.getByTestId('vendor-dashboard__credential-item'),
    `digest-${tag}.prod.internal`,
    `digest-${tag}-token`,
  );
  const submitted = await submitRequestIdentityWithCapture(
    page,
    `digest-${tag}-submit-request`,
    page.getByTestId('vendor-dashboard__submit-request-button'),
  );
  return { scenario, requestNumber: submitted.requestNumber };
}

test.describe('daily digest toggle → cron prompt → outbox (addendum-195)', () => {
  test('opted-in current-step reviewer receives exactly one digest naming their request', async ({ page }) => {
    const { scenario, requestNumber } = await provisionOwedRequest(page, 'diga', 'DIGSYSA', 'Digest E2E System A');

    await test.step('vendor L2 A sees the request in their pending dashboard and opts in', async () => {
      await login(page, scenario.vendorL2A.email, scenario.vendorL2A.password);
      // The reviewer reaches the request from their queue — never via Search
      // (addendum-178). This also proves the reviewer OWES an action, so the
      // digest has something to say.
      const approve = await pendingDashboardAction(page, requestNumber, 'vendor-dashboard__approve-button');
      await expect(approve).toBeVisible();
      // pendingDashboardAction opens the row kebab; close it before interacting
      // with other page elements (Radix dropdown overlay intercepts pointer events).
      await page.keyboard.press('Escape');

      const checkbox = page.getByTestId('digest-toggle__checkbox');
      await expect(checkbox).toBeVisible();
      await expect(checkbox).not.toBeChecked();
      await clickWithCapture(page, 'digest-opt-in-checkbox-on', checkbox);
      // The toggle is deliberately PESSIMISTIC (await-confirm): the box only
      // flips after PUT /me/pending-actions-digest responds 200.
      await expect(checkbox, 'checkbox flips only after the PUT succeeds').toBeChecked();
      await expect(page.getByTestId('digest-toggle__error')).toHaveCount(0);

      await page.reload();
      await expect(
        page.getByTestId('digest-toggle__checkbox'),
        'opt-in persists across a full reload (GET re-reads the users row)',
      ).toBeChecked();
    });

    await test.step('health prompts stage exactly one digest row for the opted-in reviewer', async () => {
      await login(page, SUPERADMIN.email, SUPERADMIN.password);
      // Pin the daily send time to 00:00 UTC (already past whenever this
      // runs) so the schedule-anchored due-check lets the prompted fan-out
      // through; restore the original schedule no matter how the poll ends.
      const originalSchedule = await readDigestSchedule(page);
      await writeDigestSchedule(page, '0 0 * * *');
      try {
        await pollOutboxCount(
          page,
          scenario.vendorL2A.email,
          1,
          'one digest envelope staged for the opted-in, owing reviewer',
        );
        // The non-opted-in teammate owes the same action and stays silent.
        expect(
          await fetchOutboxMatchCount(page, scenario.vendorL2B.email),
          'no digest for the teammate who never opted in',
        ).toBe(0);
      } finally {
        await writeDigestSchedule(page, originalSchedule);
      }
    });

    await test.step('admin outbox shows the digest row with recipient, request number, and direct link', async () => {
      await openSentNotificationsTab(page);
      const row = page.getByTestId('admin-sent-notifications__row').filter({
        has: page.locator('[data-testid="admin-sent-notifications__trigger-key-cell"]', { hasText: DIGEST_TRIGGER_KEY }),
      }).filter({ hasText: scenario.vendorL2A.email }).first();
      await expect(row).toBeVisible();
      await expect(row.getByTestId('admin-sent-notifications__recipients-cell'))
        .toContainText(scenario.vendorL2A.email);
      await expect(row.getByTestId('admin-sent-notifications__body-cell'))
        .toContainText(requestNumber);
      await expect(row.getByTestId('admin-sent-notifications__body-cell'))
        .toContainText('Review step');
      // The digest carries a per-request direct link (?dl=) — the same
      // mechanism the direct-link suites assert from the outbox.
      await expect(
        row.getByTestId('admin-sent-notifications__body-cell').locator('a[href*="?dl="]').first(),
      ).toBeVisible();

      await clickWithCapture(page, 'digest-outbox-detail-open', row);
      const detail = modalByTestId(page, 'admin-sent-notifications__detail-modal');
      await expect(detail).toBeVisible();
      await expect(detail).toContainText(scenario.vendorL2A.email);
      await expect(detail).toContainText(requestNumber);
      await detail.getByTestId('admin-sent-notifications__detail-close-button').click();
      await expect(detail).not.toBeVisible();
    });
  });

  test('opted-out reviewer stays silent through repeated health prompts (default-off pin)', async ({ page }) => {
    const { scenario, requestNumber } = await provisionOwedRequest(page, 'digb', 'DIGSYSB', 'Digest E2E System B');

    await test.step('vendor L2 A owes the review and the toggle defaults OFF', async () => {
      await login(page, scenario.vendorL2A.email, scenario.vendorL2A.password);
      await pendingDashboardAction(page, requestNumber, 'vendor-dashboard__approve-button');
      // Opt-IN contract: never checked by default, even for a user with a
      // non-empty pending derivation.
      await expect(page.getByTestId('digest-toggle__checkbox')).not.toBeChecked();
    });

    await test.step('repeated prompts stage nothing for the opted-out reviewer', async () => {
      await login(page, SUPERADMIN.email, SUPERADMIN.password);
      await pollOutboxCount(
        page,
        scenario.vendorL2A.email,
        0,
        'no digest is ever staged for a reviewer who left the toggle off',
      );

      await openAdminTab(page, 'sent-notifications', 'admin-sent-notifications__table');
      await expect(
        page.getByTestId('admin-sent-notifications__row').filter({
          has: page.locator('[data-testid="admin-sent-notifications__trigger-key-cell"]', { hasText: DIGEST_TRIGGER_KEY }),
        }).filter({ hasText: scenario.vendorL2A.email }),
        'the outbox tab agrees: zero digest rows address this recipient',
      ).toHaveCount(0);
    });
  });
});
