// Tests for the token-consuming entities in server/db/entities/identity.tsx:
// userInvites.consume() and linkMappings.consumeIfValidForUser().
//
// Both are single-statement atomic UPDATE ... RETURNING guards, and both are
// security primitives rather than plain accessors:
//
//   * userInvites.consume() is what makes an invite SINGLE-USE. The liveness
//     and expiry conditions live in the UPDATE's WHERE clause, so the row is
//     claimed and checked in one statement — two concurrent redemptions cannot
//     both win. If those predicates regressed, an expired or already-redeemed
//     invite would still mint an account, and no existing test would notice.
//   * linkMappings.consumeIfValidForUser() gates deep links. It must return a
//     row only when the key is unscoped OR scoped to this exact user, and only
//     while unexpired. Its "scoped to someone else" case is the one that stops
//     a forwarded link from working for the wrong person.
//
// The counter semantics matter too: used_at is COALESCE'd (first resolve only)
// while used_count increments on every hit, which is what makes the audit
// trail meaningful. That distinction is easy to break and invisible from the
// route layer.
import { assert, assertEquals } from "jsr:@std/assert";
import { createActiveUser, uniqueEmail, wipeDatabase } from "./helpers.tsx";
import { linkMappings, userInvites } from "../../../server/db.tsx";
import { query } from "../../../server/db/drizzle.ts";

let seq = 0;
const uniq = (p: string) => `${p}-${Date.now()}-${++seq}`;

const mkUser = async (label: string) =>
  await createActiveUser({
    fullName: `Entity ${label}`,
    email: uniqueEmail(`entity${label}`),
    password: "EntityPass!2026",
    affiliation: "agency",
  });

// expiresAt is written directly so the fixtures can be genuinely expired
// rather than merely near-expiry.
const insertInvite = async (
  token: string,
  userId: string,
  createdBy: string,
  expiresSql: string,
  consumed = false,
) => {
  await query(
    `INSERT INTO user_invites (token, user_id, created_by, created_at, expires_at, consumed_at)
     VALUES ($1, $2, $3, now(), ${expiresSql}, ${consumed ? "now()" : "NULL"})`,
    [token, userId, createdBy],
  );
};

const insertLink = async (
  key: string,
  createdBy: string,
  opts: { intendedUserId?: string | null; expiresSql?: string } = {},
) => {
  await query(
    `INSERT INTO link_mappings
       (key, target_type, target_id, created_by, created_at, intended_user_id, expires_at, used_count)
     VALUES ($1, 'breakglass_request', $2, $3, now(), $4, ${opts.expiresSql ?? "NULL"}, 0)`,
    [key, crypto.randomUUID(), createdBy, opts.intendedUserId ?? null],
  );
};

Deno.test("userInvites.consume — single-use, expiry-checked, atomic", async (t) => {
  await wipeDatabase();
  const user = await mkUser("invite");

  await t.step("positive: a live invite is consumed and returned", async () => {
    const token = uniq("tok-live");
    await insertInvite(token, user.id, user.id, "now() + interval '1 day'");

    const row = await userInvites.consume(token);
    assert(row, "a live invite must be consumable");
    assertEquals(row!.token, token);
    assertEquals(row!.userId, user.id);

    const stored = await query<{ consumed_at: string | null }>(
      `SELECT consumed_at FROM user_invites WHERE token = $1`,
      [token],
    );
    assert(stored[0]!.consumed_at !== null, "consumed_at must be stamped");
  });

  await t.step("NEGATIVE: consuming the same invite twice fails the second time", async () => {
    // The property that makes an invite single-use.
    const token = uniq("tok-once");
    await insertInvite(token, user.id, user.id, "now() + interval '1 day'");

    assert(await userInvites.consume(token), "first consume should win");
    assertEquals(await userInvites.consume(token), null, "second consume must return null");
  });

  await t.step("NEGATIVE: an expired invite cannot be consumed", async () => {
    const token = uniq("tok-expired");
    await insertInvite(token, user.id, user.id, "now() - interval '1 second'");

    assertEquals(await userInvites.consume(token), null);
    const stored = await query<{ consumed_at: string | null }>(
      `SELECT consumed_at FROM user_invites WHERE token = $1`,
      [token],
    );
    assertEquals(stored[0]!.consumed_at, null, "a failed consume must not stamp the row");
  });

  await t.step("NEGATIVE: an already-consumed invite stays refused", async () => {
    const token = uniq("tok-used");
    await insertInvite(token, user.id, user.id, "now() + interval '1 day'", true);
    assertEquals(await userInvites.consume(token), null);
  });

  await t.step("NEGATIVE: an unknown token returns null rather than throwing", async () => {
    assertEquals(await userInvites.consume(uniq("tok-missing")), null);
  });

  await t.step("get(): reads without consuming", async () => {
    const token = uniq("tok-peek");
    await insertInvite(token, user.id, user.id, "now() + interval '1 day'");

    const peeked = await userInvites.get(token);
    assertEquals(peeked?.token, token);
    assertEquals(peeked?.consumedAt ?? null, null, "get() must not consume");
    assert(await userInvites.consume(token), "still consumable afterwards");
    assertEquals(await userInvites.get(uniq("nope")), null);
  });

  await t.step("findByUser(): returns this user's invites only", async () => {
    const other = await mkUser("invite2");
    const mine = uniq("tok-mine");
    await insertInvite(mine, other.id, user.id, "now() + interval '1 day'");

    const rows = await userInvites.findByUser(other.id);
    assertEquals(rows.length, 1);
    assertEquals(rows[0]!.token, mine);
    assertEquals((await userInvites.findByUser(crypto.randomUUID())).length, 0);
  });
});

Deno.test("linkMappings.consumeIfValidForUser — scoping, TTL and hit counting", async (t) => {
  await wipeDatabase();
  const alice = await mkUser("alice");
  const bob = await mkUser("bob");

  await t.step("positive: an UNSCOPED key resolves for any user", async () => {
    const key = uniq("lk-open");
    await insertLink(key, alice.id);

    assert(await linkMappings.consumeIfValidForUser(key, alice.id));
    assert(await linkMappings.consumeIfValidForUser(key, bob.id), "unscoped keys are not user-bound");
  });

  await t.step("positive: a SCOPED key resolves for its intended user", async () => {
    const key = uniq("lk-scoped");
    await insertLink(key, alice.id, { intendedUserId: alice.id });
    const row = await linkMappings.consumeIfValidForUser(key, alice.id);
    assert(row, "the intended user must be able to resolve it");
    assertEquals(row!.key, key);
  });

  await t.step("NEGATIVE: a scoped key does NOT resolve for a different user", async () => {
    // The forwarded-link case: the key is live and unexpired, but bound to
    // someone else, so it must not resolve — and must not be counted as a hit.
    const key = uniq("lk-notyours");
    await insertLink(key, alice.id, { intendedUserId: alice.id });

    assertEquals(await linkMappings.consumeIfValidForUser(key, bob.id), null);

    const row = await query<{ used_count: number; used_at: string | null }>(
      `SELECT used_count, used_at FROM link_mappings WHERE key = $1`,
      [key],
    );
    assertEquals(Number(row[0]!.used_count), 0, "a refused resolve must not increment the counter");
    assertEquals(row[0]!.used_at, null);
  });

  await t.step("NEGATIVE: an expired key does not resolve, even for its owner", async () => {
    const key = uniq("lk-expired");
    await insertLink(key, alice.id, {
      intendedUserId: alice.id,
      expiresSql: "now() - interval '1 second'",
    });
    assertEquals(await linkMappings.consumeIfValidForUser(key, alice.id), null);
  });

  await t.step("positive: a future expiry still resolves", async () => {
    const key = uniq("lk-future");
    await insertLink(key, alice.id, { expiresSql: "now() + interval '1 hour'" });
    assert(await linkMappings.consumeIfValidForUser(key, alice.id));
  });

  await t.step("counters: used_at is set ONCE, used_count increments every hit", async () => {
    const key = uniq("lk-count");
    await insertLink(key, alice.id);

    await linkMappings.consumeIfValidForUser(key, alice.id);
    const first = await query<{ used_count: number; used_at: string }>(
      `SELECT used_count, used_at FROM link_mappings WHERE key = $1`,
      [key],
    );
    assertEquals(Number(first[0]!.used_count), 1);
    const firstUsedAt = first[0]!.used_at;
    assert(firstUsedAt !== null, "used_at must be stamped on first resolve");

    await linkMappings.consumeIfValidForUser(key, alice.id);
    await linkMappings.consumeIfValidForUser(key, alice.id);
    const later = await query<{ used_count: number; used_at: string }>(
      `SELECT used_count, used_at FROM link_mappings WHERE key = $1`,
      [key],
    );
    assertEquals(Number(later[0]!.used_count), 3, "every hit counts");
    assertEquals(later[0]!.used_at, firstUsedAt, "used_at records the FIRST resolve only");
  });

  await t.step("NEGATIVE: an unknown key returns null", async () => {
    assertEquals(await linkMappings.consumeIfValidForUser(uniq("lk-missing"), alice.id), null);
  });

  await t.step("getByKey(): reads without counting a hit", async () => {
    const key = uniq("lk-peek");
    await insertLink(key, alice.id);

    const row = await linkMappings.getByKey(key);
    assertEquals(row?.key, key);
    const counted = await query<{ used_count: number }>(
      `SELECT used_count FROM link_mappings WHERE key = $1`,
      [key],
    );
    assertEquals(Number(counted[0]!.used_count), 0, "getByKey must not count as a use");
    assertEquals(await linkMappings.getByKey(uniq("nope")), null);
  });

  await t.step("findByTarget(): filters on target type AND id", async () => {
    const targetId = crypto.randomUUID();
    const keyA = uniq("lk-t1");
    const keyB = uniq("lk-t2");
    for (const k of [keyA, keyB]) {
      await query(
        `INSERT INTO link_mappings
           (key, target_type, target_id, created_by, created_at, used_count)
         VALUES ($1, 'breakglass_request', $2, $3, now(), 0)`,
        [k, targetId, alice.id],
      );
    }
    await insertLink(uniq("lk-other"), alice.id); // different target

    const found = await linkMappings.findByTarget("breakglass_request", targetId);
    assertEquals(found.length, 2);
    assertEquals(found.map((r) => r.key).sort(), [keyA, keyB].sort());
    assertEquals((await linkMappings.findByTarget("breakglass_request", crypto.randomUUID())).length, 0);
  });

  await t.step("deleteExpired(): removes only rows past their TTL", async () => {
    const stale = uniq("lk-stale");
    const live = uniq("lk-live");
    const eternal = uniq("lk-eternal");
    await insertLink(stale, alice.id, { expiresSql: "now() - interval '1 hour'" });
    await insertLink(live, alice.id, { expiresSql: "now() + interval '1 hour'" });
    await insertLink(eternal, alice.id); // expires_at IS NULL

    await linkMappings.deleteExpired();

    assertEquals(await linkMappings.getByKey(stale), null, "expired rows are removed");
    assert(await linkMappings.getByKey(live), "unexpired rows survive");
    assert(await linkMappings.getByKey(eternal), "NULL-TTL rows must never be swept");
  });
});
