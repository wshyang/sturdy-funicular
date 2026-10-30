// Coverage: the per-system-per-day request-number sequence counter
// (server/db.tsx's nextRequestSequence), backed by the real
// request_number_sequences table that replaced the request_seq:* kv_store
// blobs. See addendum-048-kv-store-deprecation.md.
//
// The original kv-backed getNextSequence did a non-atomic read-modify-write
// (its own comment admitted the race); the replacement is a single atomic
// INSERT ... ON CONFLICT DO UPDATE ... RETURNING, so concurrent increments
// can't collide. These tests assert both the sequential semantics and that
// atomicity.
import { assertEquals } from "jsr:@std/assert";
import { wipeDatabase } from "./helpers.tsx";
import { nextRequestSequence } from "../../../server/db.tsx";
import { query } from "../../../server/pg.tsx";

Deno.test("request_sequences", async (t) => {
  await t.step("setup", async () => {
    await wipeDatabase();
  });

  await t.step("positive — increments 1, 2, 3 for the same system+date", async () => {
    const code = "SEQA";
    const date = "2026-07-24";
    assertEquals(await nextRequestSequence(code, date), 1);
    assertEquals(await nextRequestSequence(code, date), 2);
    assertEquals(await nextRequestSequence(code, date), 3);
  });

  await t.step("positive — a different date resets the counter to 1", async () => {
    const code = "SEQB";
    assertEquals(await nextRequestSequence(code, "2026-07-24"), 1);
    assertEquals(await nextRequestSequence(code, "2026-07-24"), 2);
    // New day → its own independent counter starting at 1.
    assertEquals(await nextRequestSequence(code, "2026-07-25"), 1);
  });

  await t.step("positive — different systems on the same date have independent counters", async () => {
    const date = "2026-07-26";
    assertEquals(await nextRequestSequence("SEQC", date), 1);
    assertEquals(await nextRequestSequence("SEQD", date), 1);
    assertEquals(await nextRequestSequence("SEQC", date), 2);
    assertEquals(await nextRequestSequence("SEQD", date), 2);
  });

  await t.step("concurrent — N parallel increments yield N DISTINCT counters (atomicity)", async () => {
    const code = "SEQE";
    const date = "2026-07-27";
    const N = 20;
    // Fire all increments concurrently. The atomic ON CONFLICT DO UPDATE
    // guarantees each caller gets a unique counter with no gaps or dupes — a
    // read-modify-write would collide here.
    const results = await Promise.all(
      Array.from({ length: N }, () => nextRequestSequence(code, date)),
    );
    const unique = new Set(results);
    assertEquals(unique.size, N); // no duplicates
    // The set is exactly {1..N}.
    assertEquals(Math.min(...results), 1);
    assertEquals(Math.max(...results), N);

    // And the stored counter reflects the final value.
    const rows = await query<{ counter: number }>(
      `SELECT counter FROM request_number_sequences WHERE system_short_code = $1 AND seq_date = $2`,
      [code, date],
    );
    assertEquals(rows[0].counter, N);
  });
});
