// E2E coverage for the admin Notification Templates editor
// (AdminNotificationTemplates.tsx — PUT /admin/notification-templates/:id).
// admin-panel-elements.spec.ts only *opens* the edit modal and asserts the
// four view controls are visible; nothing in the whole suite ever edits and
// saves a template. Two gaps that only a real browser can close:
//
//   1. The Source → save → Preview round-trip with a stored-XSS payload.
//      body_html is admin-authored HTML rendered via dangerouslySetInnerHTML
//      (the preview pane) after client-side DOMPurify sanitization
//      (sanitizeNotificationHtml) AND server-side sanitization
//      (sanitizeEmailHtml) on save. jsdom tests pin the sanitizer's string
//      output, but jsdom never executes scripts — only a browser proves the
//      injected payload cannot run when the persisted body is re-rendered.
//   2. The four-view state machine (Rich contentEditable → Source → Plain)
//      in a real contentEditable, which jsdom fakes poorly.
//
// Sensitivity note (verified by experiment): this pipeline has FOUR sanitize
// layers — client save (DOMPurify), server write (sanitizeEmailHtml), server
// read (sanitizeEmailHtml in getNotificationTemplates), client preview
// (DOMPurify). Bypassing any single layer is masked by the others, by design
// (defense-in-depth), so this spec pins the EMERGENT contract: with all four
// layers bypassed it fails on the persisted-<script> assertion (verified red);
// with all four intact it passes (verified green).
//
// Two tests (screenshot parity: every spec contributes exactly one automatic
// end-of-test shot per test, so file totals must stay even).
import { test, expect } from '../helpers/harness';
import { E2E_USER_EMAIL, E2E_USER_PASSWORD } from '../global-setup';
import { login, openAdminTab } from '../helpers/ui';

const SUPERADMIN = { email: E2E_USER_EMAIL, password: E2E_USER_PASSWORD };

type Page = Parameters<typeof login>[0];

async function openFirstTemplateEditor(page: Page) {
  await page.getByTestId('admin-notification-templates__edit-button').first().click();
  await expect(page.getByTestId('admin-notification-templates__edit-subject-input')).toBeVisible();
}

async function triggerKeyOfFirstRow(page: Page): Promise<string> {
  const cell = page.getByTestId('admin-notification-templates__trigger-key-cell').first();
  return (await cell.innerText()).trim();
}

async function sourceHtml(page: Page): Promise<string> {
  await page.getByTestId('admin-notification-templates__view-source').click();
  return page.getByTestId('admin-notification-templates__edit-body-textarea').inputValue();
}

async function setSourceHtml(page: Page, html: string) {
  await page.getByTestId('admin-notification-templates__view-source').click();
  await page.getByTestId('admin-notification-templates__edit-body-textarea').fill(html);
}

async function openEditorForRow(page: Page, triggerKey: string) {
  const row = page
    .getByTestId('admin-notification-templates__row')
    .filter({
      has: page.getByTestId('admin-notification-templates__trigger-key-cell')
        .getByText(triggerKey, { exact: true }),
    });
  await row.getByTestId('admin-notification-templates__edit-button').click();
  await expect(page.getByTestId('admin-notification-templates__edit-subject-input')).toBeVisible();
}

const XSS_PAYLOAD =
  '<p>Sanitized <b>keeps</b> tags.</p>' +
  "<script>window.__xss = 'pwned'</script>" +
  '<img onerror="window.__xss = \'pwned\'">';

test.describe('notification template editor (addendum-044 / addendum-193 F-26)', () => {
  test('an XSS payload saved through Source is sanitized, persisted, and never executes in Preview', async ({
    page,
    capture,
  }) => {
    await login(page, SUPERADMIN.email, SUPERADMIN.password);
    await openAdminTab(page, 'notification-templates', 'admin-notification-templates__table');

    // Capture the original body so the shared e2e DB is restored afterwards —
    // other specs (sent-notifications, notification outbox) render templates.
    await openFirstTemplateEditor(page);
    const triggerKey = await triggerKeyOfFirstRow(page);
    const originalBody = await sourceHtml(page);

    await setSourceHtml(page, XSS_PAYLOAD);
    await page.getByTestId('admin-notification-templates__save-button').click();
    // Saving closes the editor and reloads the table.
    await expect(page.getByTestId('admin-notification-templates__edit-subject-input')).toBeHidden();

    // Reopen the same template: the PERSISTED body must already be sanitized.
    await openEditorForRow(page, triggerKey);
    const persisted = await sourceHtml(page);
    expect(persisted).toContain('<b>keeps</b>');
    expect(persisted).not.toContain('<script');
    expect(persisted).not.toContain('onerror');

    // Render the persisted body in the Preview pane and prove the payload
    // cannot execute in a real browser (jsdom could not prove this).
    await page.evaluate(() => { (window as unknown as Record<string, unknown>)['__xss'] = undefined; });
    await page.getByTestId('admin-notification-templates__view-preview').click();
    const pane = page.getByTestId('admin-notification-templates__preview-pane');
    await expect(pane).toBeVisible();
    await expect(pane).toContainText('Sanitized');
    await expect(pane.locator('b')).toContainText('keeps');
    await expect(pane.locator('script')).toHaveCount(0);
    await expect(pane.locator('img[onerror]')).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as Record<string, unknown>)['__xss'])).toBeUndefined();

    // The whole journey must have been console-error free (no CSP/React
    // errors, no script-execution fallout).
    capture.expectCleanConsole([/Failed to load resource/]);

    // Restore the template's original body for the rest of the run.
    await setSourceHtml(page, originalBody);
    await page.getByTestId('admin-notification-templates__save-button').click();
    await expect(page.getByTestId('admin-notification-templates__edit-subject-input')).toBeHidden();
  });

  test('the Rich contentEditable flows into Source and Plain views without tags', async ({ page }) => {
    await login(page, SUPERADMIN.email, SUPERADMIN.password);
    await openAdminTab(page, 'notification-templates', 'admin-notification-templates__table');
    await openFirstTemplateEditor(page);

    // Default view is Rich (contentEditable) — type into it like a user.
    await page.getByTestId('admin-notification-templates__rich-editor').fill('E2E rich round-trip');

    // Source shows the typed content (wrapped in editor-added tags).
    await page.getByTestId('admin-notification-templates__view-source').click();
    const sourceValue = await page
      .getByTestId('admin-notification-templates__edit-body-textarea')
      .inputValue();
    expect(sourceValue).toContain('E2E rich round-trip');

    // Plain derives via htmlToPlainText — the tag-wrapped markup must reduce
    // to the bare text, proving the four-view state machine in a real browser.
    await page.getByTestId('admin-notification-templates__view-plain').click();
    const plainPane = page.getByTestId('admin-notification-templates__plain-pane');
    await expect(plainPane).toContainText('E2E rich round-trip');
    expect((await plainPane.innerText()).trim()).toBe('E2E rich round-trip');

    // Close without saving (the ✕ discards edits) — no restore needed.
    await page.getByTestId('admin-notification-templates__edit-modal-close-button').click();
    await expect(page.getByTestId('admin-notification-templates__edit-subject-input')).toBeHidden();
  });
});
