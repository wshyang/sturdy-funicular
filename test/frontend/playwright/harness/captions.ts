// On-screen caption overlay for recorded/demo runs — burned into the video
// itself (not just the Playwright HTML report), telling a human viewer what
// is happening on screen right now.
//
// Moved from test/frontend/playwright/demo/helpers/index.ts during the
// addendum-194 harness unification so the NEW harness (harness/test.ts) can
// render captions too, not just the demo suites. demo/helpers re-exports
// these for backwards compatibility — there is exactly ONE implementation.
//
// The overlay must survive every full-page navigation the scenario triggers
// (every login() does a page.goto('/')) — an element injected via
// page.evaluate() alone would vanish on the very next reload. Solved by
// pairing an addInitScript (re-runs on every new document, rebuilding the
// DOM node) with localStorage (persists the current caption text ACROSS
// those reloads, since addInitScript reruns don't have access to the
// previous document's JS state).
import type { Page } from '@playwright/test';

const CAPTION_STORAGE_KEY = '__demoCaptionText';
const CAPTION_ELEMENT_ID = '__demo-caption-overlay';

// Runs inside the page on every new document (initial load AND every
// subsequent navigation) — rebuilds the overlay node and repopulates it from
// whatever caption text was last persisted, so a caption set before a login
// redirect is still showing once the new page settles. page.addInitScript
// only forwards a SINGLE arg to the function (confirmed against
// playwright-core's addInitScript<Arg>(script, arg?: Arg) signature), so
// storageKey/elementId are bundled into one object rather than passed
// positionally.
function captionInitScript({ storageKey, elementId }: { storageKey: string; elementId: string }): void {
  // addInitScript runs at the very start of navigation — often before the
  // parser has even created <html>, so document.documentElement is still
  // null (confirmed via a debug run: appendChild threw "Cannot read
  // properties of null"). whenReady() defers the actual DOM write until
  // documentElement exists, via a MutationObserver watching `document`
  // itself for childList changes, rather than assuming any particular
  // readyState has already been reached.
  function whenReady(cb: () => void): void {
    if (document.documentElement) {
      cb();
      return;
    }
    const observer = new MutationObserver(() => {
      if (document.documentElement) {
        observer.disconnect();
        cb();
      }
    });
    observer.observe(document, { childList: true });
  }

  function render(text: string): void {
    whenReady(() => {
      let el = document.getElementById(elementId);
      if (!el) {
        el = document.createElement('div');
        el.id = elementId;
        Object.assign(el.style, {
          position: 'fixed',
          top: '16px',
          left: '16px',
          zIndex: '2147483647',
          background: 'rgba(10, 14, 21, 0.92)',
          color: '#e6edf3',
          border: '1px solid rgba(255,255,255,0.18)',
          borderRadius: '8px',
          padding: '10px 18px',
          fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, sans-serif',
          fontSize: '19px',
          fontWeight: '600',
          lineHeight: '1.35',
          maxWidth: '760px',
          pointerEvents: 'none',
          boxShadow: '0 4px 20px rgba(0,0,0,0.45)',
        });
        document.documentElement.appendChild(el);
      }
      el.textContent = text;
    });
  }
  (window as unknown as { __setDemoCaption: (t: string) => void }).__setDemoCaption = render;
  try {
    const stored = window.localStorage.getItem(storageKey);
    if (stored) render(stored);
  } catch {
    // about:blank / other localStorage-denied documents — nothing stored yet.
  }
}

// Call ONCE per test, before any navigation happens (i.e. before the first
// login()/page.goto()) — registers the init script for the page's whole
// lifetime, so every later reload re-creates the overlay automatically.
export async function installCaptionOverlay(page: Page): Promise<void> {
  await page.addInitScript(captionInitScript, { storageKey: CAPTION_STORAGE_KEY, elementId: CAPTION_ELEMENT_ID });
}

// Updates the caption text immediately (no reload needed) and persists it to
// localStorage so it also survives whatever navigation happens next. The
// very first call in a test can land while the page is still on the
// sandboxed `about:blank` document (before the first login()/page.goto()) —
// localStorage access throws a SecurityError there, so both accesses are
// guarded: the caption is simply not shown yet in that case, and shows up
// as soon as the first real navigation runs the init script.
export async function setCaption(page: Page, text: string): Promise<void> {
  await page.evaluate(
    ({ text: captionText, storageKey }) => {
      try {
        window.localStorage.setItem(storageKey, captionText);
      } catch {
        // about:blank (pre-navigation) — nothing to persist yet.
      }
      const setter = (window as unknown as { __setDemoCaption?: (t: string) => void }).__setDemoCaption;
      if (setter) setter(captionText);
    },
    { text, storageKey: CAPTION_STORAGE_KEY },
  );
}
