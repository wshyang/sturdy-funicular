// Accept-invite two-party flow (addendum-140 G4, executed in addendum-141):
// the ONE core lifecycle that had zero click-through coverage — only jsdom
// (AcceptInvitePage.test.tsx) and deno (invite.test.tsx) tiers existed.
//
//   test 1 (positive journey + inline weak-password negative): the admin
//     invites through the real modal with notify ON, the invitee redeems the
//     EMAILED link (read out of the admin Sent-Emails outbox — the actual
//     user.invited envelope, never the modal's echo) in a FRESH browser
//     context, a weak password is rejected inline, and a valid one lands on
//     the 2FA-enrollment gate.
//   test 2 (negative): a fabricated token renders the server rejection
//     inline — the redeem page is not a silent dead end.
//
// Zero-shot + even-pair invariants hold (addendum-139 e2e discipline): both
// tests pass on a freshly bootstrapped stack with no ordering assumptions.
import { test, expect } from '../helpers/harness';
import { E2E_USER_EMAIL, E2E_USER_PASSWORD } from '../global-setup';
import { login } from '../helpers/ui';
import { openSentNotificationsTab } from '../helpers/direct-link';

const SUPERADMIN = { email: E2E_USER_EMAIL, password: E2E_USER_PASSWORD };
const STRONG_PASSWORD = 'Invited!2026xYz';

test.describe('accept-invite — the two-party lifecycle in a browser', () => {
  test('admin invite → outbox link → redeem in a fresh context → weak-password inline negative → 2FA-enroll gate', async ({ page, browser }) => {
    const runId = `${Date.now()}`;
    const inviteeEmail = `e2e-invitee-${runId}@test.local`;

    // ── Party 1 (admin): invite with notify ON ─────────────────────────────
    await login(page, SUPERADMIN.email, SUPERADMIN.password);
    await page.getByTestId('admin-panel__tab-users').click();
    await page.getByTestId('admin-users__invite-button').click();
    await expect(page.getByTestId('admin-users__invite-modal')).toBeVisible();
    await page.getByTestId('admin-users__invite-name-input').fill(`E2E Invitee ${runId}`);
    await page.getByTestId('admin-users__invite-email-input').fill(inviteeEmail);
    await page.getByTestId('admin-users__invite-affiliation-select').selectOption('agency');
    await expect(page.getByTestId('admin-users__invite-notify-checkbox')).toBeChecked();
    await page.getByTestId('admin-users__invite-submit-button').click();
    // The modal switches to the success/link panel (invite link echoed for
    // manual sharing) — proof the POST /admin/users/invite 201 landed.
    await expect(page.getByTestId('admin-users__invite-link')).toContainText('/invite/');
    await page.getByTestId('admin-users__invite-done-button').click();

    // ── The emailed link: read the user.invited envelope's anchor out of
    // the admin outbox (the abstraction boundary the audit requires — what
    // the invitee RECEIVES, not what the modal drew).
    await openSentNotificationsTab(page);
    const row = page.locator('[data-testid="admin-sent-notifications__row"]', {
      has: page.locator('[data-testid="admin-sent-notifications__trigger-key-cell"]', { hasText: /^user\.invited$/ }),
    }).first();
    await expect(row).toBeVisible();
    const link = row.locator('[data-testid="admin-sent-notifications__body-cell"] a[href*="/invite/"]').first();
    await expect(link).toBeVisible();
    const inviteUrl = await link.getAttribute('href');
    if (!inviteUrl) throw new Error('user.invited outbox row carries no /invite/ anchor');

    // ── Party 2 (invitee): redeem in a FRESH context (no admin session) ────
    const inviteeContext = await browser.newContext();
    const invitee = await inviteeContext.newPage();
    await invitee.goto(inviteUrl);
    await expect(invitee.getByTestId('accept-invite-page')).toBeVisible();

    // Inline negative: a weak password is rejected with the policy message —
    // no session is minted on the failed arm.
    await invitee.getByTestId('accept-invite-page__password-input').fill('weak');
    await invitee.getByTestId('accept-invite-page__confirm-input').fill('weak');
    await invitee.getByTestId('accept-invite-page__submit-button').click();
    await expect(invitee.getByTestId('accept-invite-page__error')).toContainText(/Password must/);
    await expect(invitee.getByTestId('accept-invite-page')).toBeVisible();

    // Positive: a compliant password redeems and lands on the 2FA gate.
    await invitee.getByTestId('accept-invite-page__password-input').fill(STRONG_PASSWORD);
    await invitee.getByTestId('accept-invite-page__confirm-input').fill(STRONG_PASSWORD);
    await invitee.getByTestId('accept-invite-page__submit-button').click();
    await expect(invitee.getByTestId('two-factor-enroll__qr-image')).toBeVisible();
    await inviteeContext.close();
  });

  test('negative: a fabricated invite token renders the server rejection inline', async ({ page }) => {
    await page.goto('/invite/not-a-real-token-000');
    await expect(page.getByTestId('accept-invite-page')).toBeVisible();
    await page.getByTestId('accept-invite-page__password-input').fill(STRONG_PASSWORD);
    await page.getByTestId('accept-invite-page__confirm-input').fill(STRONG_PASSWORD);
    await page.getByTestId('accept-invite-page__submit-button').click();
    await expect(page.getByTestId('accept-invite-page__error')).toBeVisible();
    // The gate must NOT open on a failed redeem.
    await expect(page.getByTestId('two-factor-enroll__qr-image')).not.toBeVisible();
  });
});
