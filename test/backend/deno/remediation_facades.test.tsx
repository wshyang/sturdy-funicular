// Conversation-wide facade and separation contracts (phases 3, 5, 6, 9-11).
import { assert, assertEquals, assertStrictEquals } from "jsr:@std/assert";
import * as auth from "../../../server/auth.tsx";
import * as sessions from "../../../server/auth-session.tsx";
import * as roles from "../../../server/auth-admin-roles.tsx";
import * as capabilityCatalog from "../../../server/auth-admin-capabilities.ts";
import * as authRoutes from "../../../server/routes/auth.tsx";
import * as authSecurityRoutes from "../../../server/routes/auth-security.tsx";
import * as typeFacade from "../../../server/types.tsx";
import * as coreTypes from "../../../server/types/core.tsx";

Deno.test("remediation facades preserve runtime exports and separation", async (t) => {
  await t.step("auth facade re-exports session transport by identity", () => {
    assertStrictEquals(auth.createSession, sessions.createSession);
    assertStrictEquals(auth.getSession, sessions.getSession);
    assertStrictEquals(auth.getSessionToken, sessions.getSessionToken);
    assertStrictEquals(auth.setSessionCookie, sessions.setSessionCookie);
  });

  await t.step("auth route facade re-exports security handlers by identity", () => {
    assertStrictEquals(authRoutes.enroll2FA, authSecurityRoutes.enroll2FA);
    assertStrictEquals(authRoutes.verify2FA, authSecurityRoutes.verify2FA);
    assertStrictEquals(authRoutes.acceptInvite, authSecurityRoutes.acceptInvite);
    assertStrictEquals(authRoutes.changePassword, authSecurityRoutes.changePassword);
  });

  await t.step("role facade re-exports one capability catalogue", () => {
    assertStrictEquals(roles.ALL_CAPABILITIES, capabilityCatalog.ALL_CAPABILITIES);
    assertStrictEquals(roles.PRECONFIGURED_ROLES, capabilityCatalog.PRECONFIGURED_ROLES);
    assertEquals("hasAdminPrivilege" in roles, false);
    assertEquals(typeof auth.hasAdminPrivilege, "function");
  });

  await t.step("domain type facade preserves runtime actor constants", () => {
    assertEquals(typeFacade.SYSTEM_USER_ID, coreTypes.SYSTEM_USER_ID);
    assertEquals(typeFacade.UNKNOWN_USER_ID, coreTypes.UNKNOWN_USER_ID);
  });

  await t.step("notification producer contains no provider IO imports", async () => {
    const source = await Deno.readTextFile(
      new URL("../../../server/email/notify.tsx", import.meta.url),
    );
    for (const forbidden of [
      "sendPostmanEmail",
      "sendSesEmail",
      "sendSmtpEmail",
      "sendSlackDM",
    ]) {
      assertEquals(source.includes(forbidden), false, `${forbidden} leaked into producer`);
    }
    assert(source.includes("runInTransaction"));
  });
});
