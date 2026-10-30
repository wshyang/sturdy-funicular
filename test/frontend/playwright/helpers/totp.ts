// QR-decode TOTP harness for the e2e suite (addendum-046-totp-2fa.md).
//
// The 2FA enrollment spec must NOT read the secret out of the DOM/data-URL
// string — it must recover it the way a real user's phone does: by reading
// the RENDERED PIXELS of the QR code. So decodeTotpSecretFromQr() takes a
// screenshot of the enrollment modal's <img>, decodes the PNG into RGBA,
// runs jsqr over the pixels to recover the otpauth:// URI, and parses out the
// base32 secret. computeTotp() then derives the current 6-digit code with the
// same otpauth library / pinned parameters the server uses.
//
// This is the real end-to-end second factor: the code entered into the modal
// is computed from the pixels the browser actually painted, never from a
// value the test was handed out-of-band.
import type { Page } from '@playwright/test';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';
import * as OTPAuth from 'otpauth';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Per-run store of the TOTP secret each e2e user was shown during enrollment,
// keyed by email. Written to disk (not just memory) because it must survive
// across logout→login within a spec, and there is no other place the secret
// legitimately exists — it was only ever shown once, in the enrollment QR.
// This is the honest counterpart to the old hardcoded fixture secret: the
// value here is always the one decoded from the browser's rendered pixels,
// never seeded. Gitignored (test_output/e2e/.totp-secrets.json — run
// artifacts live under test_output/, see
// addendum-052-test-output-consolidation.md). Single-worker suite
// (playwright.config.ts workers:1), so no cross-process race within one run.
// The filename is stack-specific to prevent concurrent parallel demo runs
// (each with their own E2E_STACK_ID) from corrupting each other's entries.
const _stackId = process.env['E2E_STACK_ID'] ?? '0';
const SECRET_STORE = join(process.cwd(), 'test_output', 'e2e', `.totp-secrets-${_stackId}.json`);

function readStore(): Record<string, string> {
  if (!existsSync(SECRET_STORE)) return {};
  try {
    return JSON.parse(readFileSync(SECRET_STORE, 'utf8'));
  } catch {
    return {};
  }
}

export function rememberSecret(email: string, secret: string): void {
  mkdirSync(join(process.cwd(), 'test_output', 'e2e'), { recursive: true });
  const store = readStore();
  store[email] = secret;
  writeFileSync(SECRET_STORE, JSON.stringify(store));
}

export function recallSecret(email: string): string | undefined {
  return readStore()[email];
}

// Screenshot the QR <img> and decode the otpauth:// URI from its pixels.
export async function decodeOtpauthUriFromQr(page: Page, qrTestId: string): Promise<string> {
  const img = page.getByTestId(qrTestId);
  await img.waitFor({ state: 'visible' });
  const pngBuffer = await img.screenshot();
  const png = PNG.sync.read(pngBuffer);
  const result = jsQR(
    new Uint8ClampedArray(png.data),
    png.width,
    png.height,
  );
  if (!result) {
    throw new Error('Failed to decode the QR code from the enrollment image pixels.');
  }
  return result.data;
}

// Parse the base32 secret out of an otpauth:// URI.
export function secretFromOtpauthUri(uri: string): string {
  const secret = new URL(uri).searchParams.get('secret');
  if (!secret) throw new Error(`No secret in otpauth URI: ${uri}`);
  return secret;
}

// Current 6-digit TOTP code for a base32 secret — same pinned
// algorithm/digits/period as server/twofa.tsx.
export function computeTotp(secretBase32: string): string {
  const totp = new OTPAuth.TOTP({
    issuer: 'Firefighter Station',
    label: 'e2e',
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secretBase32),
  });
  return totp.generate();
}

// Convenience: decode the QR from the enrollment modal and return the secret
// in one call.
export async function recoverSecretFromEnrollModal(page: Page): Promise<string> {
  const uri = await decodeOtpauthUriFromQr(page, 'two-factor-enroll__qr-image');
  return secretFromOtpauthUri(uri);
}
