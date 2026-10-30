// Coverage: TOTP_LOGIN_ENFORCEMENT_ENABLED (addendum-212). Enrollment is
// NEVER optional — only whether an already-enrolled user's login additionally
// demands a live /auth/2fa/verify code is gated by this env var. Real TOTP
// throughout, no mocks (same posture as twofa.test.tsx).
import { assertEquals } from "jsr:@std/assert";
import {
  req, authHeaders, wipeDatabase, createActiveUser, uniqueEmail,
} from "./helpers.tsx";
import { clearAppSettingsCache } from "../../../server/app-settings.tsx";

function restoreEnv(name: string, previous: string | undefined): void {
  if (previous === undefined) Deno.env.delete(name);
  else Deno.env.set(name, previous);
}

const ENV = "TOTP_LOGIN_ENFORCEMENT_ENABLED";

Deno.test("twofa login enforcement toggle", async (t) => {
  await t.step("setup", async () => {
    await wipeDatabase();
  });

  await t.step("enforcement disabled: an enrolled user's login skips needs2faVerification and reaches operational routes immediately", async () => {
    const prev = Deno.env.get(ENV);
    try {
      Deno.env.set(ENV, "false");
      const email = uniqueEmail("enforce-off-enrolled");
      await createActiveUser({
        fullName: "Enforce Off Enrolled", email, password: "EnforceOff!2026", affiliation: "vendor",
        // enrolled by default
      });
      const login = await req("/auth/login", { method: "POST", body: { email, password: "EnforceOff!2026" } });
      assertEquals(login.status, 200);
      const data = await login.json();
      assertEquals(data.needs2faEnrollment, false);
      assertEquals(data.needs2faVerification, false, "enforcement off must suppress the verify prompt for an enrolled user");

      // No /auth/2fa/verify call made — the gate must already pass.
      const res = await req("/requests/my-requests", { headers: authHeaders(data.session) });
      assertEquals(res.status, 200);
    } finally {
      restoreEnv(ENV, prev);
      clearAppSettingsCache();
    }
  });

  await t.step("enforcement disabled: a never-enrolled user still gets needs2faEnrollment and the gate still blocks until enrolled", async () => {
    const prev = Deno.env.get(ENV);
    try {
      Deno.env.set(ENV, "false");
      const email = uniqueEmail("enforce-off-unenrolled");
      await createActiveUser({
        fullName: "Enforce Off Unenrolled", email, password: "EnforceOffU!2026", affiliation: "vendor", enroll2fa: false,
      });
      const login = await req("/auth/login", { method: "POST", body: { email, password: "EnforceOffU!2026" } });
      assertEquals(login.status, 200);
      const data = await login.json();
      assertEquals(data.needs2faEnrollment, true, "enrollment is never optional, regardless of the enforcement toggle");
      assertEquals(data.needs2faVerification, false);

      const res = await req("/requests/my-requests", { headers: authHeaders(data.session) });
      assertEquals(res.status, 403);
      assertEquals((await res.json()).code, "twofa_required");
    } finally {
      restoreEnv(ENV, prev);
      clearAppSettingsCache();
    }
  });

  await t.step("enforcement enabled (default/unset): an enrolled user's login still demands needs2faVerification", async () => {
    const prev = Deno.env.get(ENV);
    try {
      Deno.env.delete(ENV);
      const email = uniqueEmail("enforce-on-enrolled");
      await createActiveUser({
        fullName: "Enforce On Enrolled", email, password: "EnforceOn!2026", affiliation: "vendor",
      });
      const login = await req("/auth/login", { method: "POST", body: { email, password: "EnforceOn!2026" } });
      assertEquals(login.status, 200);
      const data = await login.json();
      assertEquals(data.needs2faVerification, true);

      const res = await req("/requests/my-requests", { headers: authHeaders(data.session) });
      assertEquals(res.status, 403);
      assertEquals((await res.json()).code, "twofa_required");
    } finally {
      restoreEnv(ENV, prev);
      clearAppSettingsCache();
    }
  });

  await t.step("enforcement enabled explicitly ('true'): same as default", async () => {
    const prev = Deno.env.get(ENV);
    try {
      Deno.env.set(ENV, "true");
      const email = uniqueEmail("enforce-on-explicit");
      await createActiveUser({
        fullName: "Enforce On Explicit", email, password: "EnforceOnExp!2026", affiliation: "vendor",
      });
      const login = await req("/auth/login", { method: "POST", body: { email, password: "EnforceOnExp!2026" } });
      const data = await login.json();
      assertEquals(data.needs2faVerification, true);
    } finally {
      restoreEnv(ENV, prev);
      clearAppSettingsCache();
    }
  });

  await t.step("enforcement toggle: an EMPTY env var is treated as unset (fail closed, enforced)", async () => {
    const prev = Deno.env.get(ENV);
    try {
      Deno.env.set(ENV, "");
      const email = uniqueEmail("enforce-empty");
      await createActiveUser({
        fullName: "Enforce Empty", email, password: "EnforceEmpty!2026", affiliation: "vendor",
      });
      const login = await req("/auth/login", { method: "POST", body: { email, password: "EnforceEmpty!2026" } });
      const data = await login.json();
      assertEquals(data.needs2faVerification, true, "empty env must not disable enforcement");
    } finally {
      restoreEnv(ENV, prev);
      clearAppSettingsCache();
    }
  });

  await t.step("enforcement toggle: any value other than 'true' reads as enforced (fail closed)", async () => {
    const prev = Deno.env.get(ENV);
    try {
      for (const raw of ["1", "FALSE", "no", "off", "garbage"]) {
        Deno.env.set(ENV, raw);
        const email = uniqueEmail("enforce-garbage");
        await createActiveUser({
          fullName: "Enforce Garbage", email, password: "EnforceGarbage!2026", affiliation: "vendor",
        });
        const login = await req("/auth/login", { method: "POST", body: { email, password: "EnforceGarbage!2026" } });
        const data = await login.json();
        assertEquals(data.needs2faVerification, true, `env=${raw} must not disable enforcement`);
      }
    } finally {
      restoreEnv(ENV, prev);
      clearAppSettingsCache();
    }
  });
});
