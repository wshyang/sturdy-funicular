// Coverage: the two reserved, permanent system-actor rows
// (SYSTEM_USER_ID/UNKNOWN_USER_ID) seeded by
// migrations/011_add_uuidv7_and_system_actor_users.sql — see
// addendum-041-uuidv7-and-object-lifecycle-traceability.md.
import { assertEquals, assertExists } from "jsr:@std/assert";
import { users } from "../../../server/db.tsx";
import { query } from "../../../server/pg.tsx";
import { SYSTEM_USER_ID, UNKNOWN_USER_ID } from "../../../server/types.tsx";
import { req, wipeDatabase } from "./helpers.tsx";

Deno.test("reserved system-actor rows", async (t) => {
  await t.step("setup", async () => {
    await wipeDatabase();
  });

  await t.step("positive — both reserved rows exist post-wipe, at their exact fixed ids, with is_system true", async () => {
    // wipeDatabase() itself must NOT have removed these — proves the
    // WHERE NOT is_system exemption is load-bearing, not just theoretical.
    const system = await users.get(SYSTEM_USER_ID);
    const unknown = await users.get(UNKNOWN_USER_ID);
    assertExists(system);
    assertExists(unknown);
    assertEquals((system as any).isSystem, true);
    assertEquals((unknown as any).isSystem, true);
  });

  await t.step("negative — direct UPDATE against a reserved row is rejected by the DB trigger", async () => {
    let threw = false;
    try {
      await query(`UPDATE users SET full_name = $1 WHERE id = $2`, ["Hacked", SYSTEM_USER_ID]);
    } catch (err) {
      threw = /reserved system-actor row/.test(String((err as Error).message));
    }
    assertEquals(threw, true);

    // Confirm the row is genuinely untouched, not just that the statement errored.
    const stillThere = await users.get(SYSTEM_USER_ID);
    assertEquals(stillThere!.fullName, "System");
  });

  await t.step("negative — direct DELETE against a reserved row is rejected by the DB trigger", async () => {
    let threw = false;
    try {
      await query(`DELETE FROM users WHERE id = $1`, [UNKNOWN_USER_ID]);
    } catch (err) {
      threw = /reserved system-actor row/.test(String((err as Error).message));
    }
    assertEquals(threw, true);

    const stillThere = await users.get(UNKNOWN_USER_ID);
    assertExists(stillThere);
  });

  await t.step("negative — login() rejects an attempt against a reserved row's email", async () => {
    // The reserved rows' password_hash is a fixed placeholder no real
    // hashPassword() output can ever equal — login() needs no special-cased
    // is_system check, since password verification alone already rejects
    // this. This test proves that guarantee holds, not that a dedicated
    // check exists (none does, and none is needed).
    const res = await req("/auth/login", {
      method: "POST",
      body: { email: "system@internal.breakglass.local", password: "unusable-reserved-row" },
    });
    assertEquals(res.status, 401);
  });
});
