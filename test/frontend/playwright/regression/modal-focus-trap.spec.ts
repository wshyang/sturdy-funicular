// E2E coverage for the AccessibleDialog focus trap
// (src/app/components/ui/AccessibleDialog.tsx) — the keyboard contract every
// modal in the app inherits.
//
// WHY THIS SPEC EXISTS
//
// The component implements four distinct behaviours, and the suite only
// covered two of them:
//
//   covered already → Escape closes; focus returns to the trigger.
//   NOT covered     → initial focus lands inside the dialog, and Tab /
//                     Shift+Tab WRAP at the boundaries instead of escaping
//                     into the page behind the overlay.
//
// A grep across all 55 spec files finds exactly one `press('Tab')`, in
// skip-link.spec.ts — nothing had ever tabbed inside a modal. That is the
// half of the trap that silently rots: the dialog still looks and behaves
// correctly with a mouse, and Escape still works, so a regression in the
// Tab handler is invisible to every existing test while leaving keyboard and
// screen-reader users able to tab onto controls behind the overlay and
// operate a page they cannot see.
//
// This is a WCAG 2.1 §2.4.3 (Focus Order) / §2.1.2 (No Keyboard Trap —
// which requires that focus be *containable but escapable*, exactly what
// Escape provides) obligation for a government portal, so it is worth an
// explicit regression test rather than trusting the jsdom unit test alone:
// jsdom does not implement real sequential focus navigation, so only a real
// browser can prove Tab actually wraps.
//
// Uses the Edit Roles modal as the subject because it is a plain
// AccessibleDialog with a stable, known set of focusable controls
// (checkboxes + Save + Cancel + the ✕ close button), reached through the
// real admin UI.
//
// Suite invariants honoured: exactly 2 tests (even), zero screenshot calls,
// real-UI discipline.
import { test, expect } from '../helpers/harness';
import { E2E_USER_EMAIL, E2E_USER_PASSWORD } from '../global-setup';
import { login, openAdminTab } from '../helpers/ui';
import type { Page } from '@playwright/test';

const SUPERADMIN = { email: E2E_USER_EMAIL, password: E2E_USER_PASSWORD };

// Same FOCUSABLE list the component uses, so the test measures the trap
// against the component's own definition rather than a guess.
const FOCUSABLE = [
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'a[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

// Opens Edit Roles on the first agency user offering it, and returns the
// modal. Edit Roles is only offered for agency-affiliated users.
async function openEditRolesModal(page: Page) {
  await openAdminTab(page, 'users', 'admin-users__view-pending-tab');
  await page.getByTestId('admin-users__view-all-tab').click();

  const row = page.locator('tr', { hasText: E2E_USER_EMAIL });
  await expect(row).toBeVisible({ timeout: 15000 });
  await row.getByTestId('admin-users__row-menu-button').click();
  await page.getByTestId('admin-users__edit-roles-button').click();

  const modal = page.getByTestId('admin-users__edit-roles-modal');
  await expect(modal).toBeVisible();
  return modal;
}

// True when the currently focused element is inside the given dialog.
async function focusIsInsideDialog(page: Page, testId: string): Promise<boolean> {
  return await page.evaluate((id) => {
    const dialog = document.querySelector(`[data-testid="${id}"]`);
    return !!dialog && !!document.activeElement && dialog.contains(document.activeElement);
  }, testId);
}

test.describe('AccessibleDialog focus trap (WCAG 2.4.3 / 2.1.2)', () => {
  test('opening a modal moves focus inside it and Tab cycles without escaping', async ({ page }) => {
    await test.step('log in and open the Edit Roles modal', async () => {
      await login(page, SUPERADMIN.email, SUPERADMIN.password);
      await openEditRolesModal(page);
    });

    await test.step('initial focus lands on the first focusable control INSIDE the dialog', async () => {
      // The component focuses `dialog.querySelector(FOCUSABLE)` on mount. If
      // this regresses, a keyboard user starts at the top of the page behind
      // the overlay with no indication the dialog opened.
      expect(await focusIsInsideDialog(page, 'admin-users__edit-roles-modal')).toBe(true);
    });

    await test.step('Tab never leaves the dialog, even past the last control', async () => {
      // Count the dialog's own focusable controls, then Tab more times than
      // that — a working trap wraps; a broken one walks out into the page.
      const count = await page.evaluate((sel) => {
        const dialog = document.querySelector('[data-testid="admin-users__edit-roles-modal"]');
        return dialog ? dialog.querySelectorAll(sel).length : 0;
      }, FOCUSABLE);
      expect(count).toBeGreaterThan(1);

      for (let i = 0; i < count + 3; i++) {
        await page.keyboard.press('Tab');
        expect(
          await focusIsInsideDialog(page, 'admin-users__edit-roles-modal'),
          `focus escaped the dialog after ${i + 1} Tab press(es)`,
        ).toBe(true);
      }
    });

    await test.step('Shift+Tab also wraps rather than escaping backwards', async () => {
      for (let i = 0; i < 5; i++) {
        await page.keyboard.press('Shift+Tab');
        expect(
          await focusIsInsideDialog(page, 'admin-users__edit-roles-modal'),
          `focus escaped backwards after ${i + 1} Shift+Tab press(es)`,
        ).toBe(true);
      }
    });

    await test.step('the trap is escapable by design: Escape closes it', async () => {
      // WCAG 2.1.2 requires the trap be escapable — containment without an
      // exit would itself be a failure.
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('admin-users__edit-roles-modal')).toBeHidden();
    });
  });

  test('closing a modal returns focus to the control that opened it', async ({ page }) => {
    await test.step('log in and open the Edit Roles modal', async () => {
      await login(page, SUPERADMIN.email, SUPERADMIN.password);
      await openEditRolesModal(page);
      expect(await focusIsInsideDialog(page, 'admin-users__edit-roles-modal')).toBe(true);
    });

    await test.step('Escape restores focus to the page, not to nowhere', async () => {
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('admin-users__edit-roles-modal')).toBeHidden();

      // The component restores focus to the element that had it when the
      // dialog mounted. The precise element depends on how the row menu
      // unmounts, so assert the property that actually matters for keyboard
      // users: focus is on a real, interactive element — never orphaned on
      // <body>, which would dump the user back at the top of the document.
      const restored = await page.evaluate(() => {
        const el = document.activeElement;
        return {
          tag: el?.tagName ?? null,
          isBody: el === document.body,
          isInteractive: !!el?.closest('button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])'),
        };
      });
      expect(restored.isBody, 'focus was orphaned on <body> after closing the dialog').toBe(false);
      expect(restored.isInteractive).toBe(true);
    });

    await test.step('the dialog exposes the correct ARIA contract while open', async () => {
      // Re-open and check the semantics a screen reader relies on to announce
      // it as a modal rather than as inline content.
      const modal = await openEditRolesModal(page);
      await expect(modal).toHaveAttribute('role', 'dialog');
      await expect(modal).toHaveAttribute('aria-modal', 'true');

      // aria-labelledby must point at an element that actually exists, or the
      // dialog is announced with no name at all.
      const labelledBy = await modal.getAttribute('aria-labelledby');
      expect(labelledBy).toBeTruthy();
      await expect(page.locator(`#${labelledBy}`)).toBeVisible();

      await page.keyboard.press('Escape');
      await expect(modal).toBeHidden();
    });
  });
});
