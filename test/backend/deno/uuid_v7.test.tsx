// Coverage: server/db.tsx's generateId() — verifies it actually produces
// UUIDv7 (RFC 9562), not v4, and that its whole point (timestamp ordering)
// holds in practice. See addendum-041-uuidv7-and-object-lifecycle-
// traceability.md.
import { assertEquals, assert } from "jsr:@std/assert";
import { generateId, clusters } from "../../../server/db.tsx";
import { wipeDatabase, createAdmin, fixtureFallbackOrgId } from "./helpers.tsx";

const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function timestampMs(uuid: string): number {
  // First 48 bits (12 hex chars, minus the hyphen after the 8th) are the
  // Unix-epoch-ms timestamp — see uuid_generate_v7()'s own layout comment
  // in setup/sql/001_schema.sql.
  const hex = uuid.replace(/-/g, "").slice(0, 12);
  return parseInt(hex, 16);
}

Deno.test("generateId() — UUIDv7", async (t) => {
  await t.step("shape — version nibble 7, variant bits 10 (8/9/a/b)", () => {
    for (let i = 0; i < 20; i++) {
      const id = generateId();
      assert(UUID_V7_RE.test(id), `expected UUIDv7 shape, got ${id}`);
    }
  });

  await t.step("ordering — successive calls have non-decreasing timestamp components", () => {
    const ids = Array.from({ length: 50 }, () => generateId());
    const timestamps = ids.map(timestampMs);
    for (let i = 1; i < timestamps.length; i++) {
      assert(timestamps[i] >= timestamps[i - 1], `id ${i} (${ids[i]}) has an earlier timestamp than id ${i - 1} (${ids[i - 1]})`);
    }
  });

  await t.step("real insert ordering — id ordering matches created_at ordering on a live table (the actual point of v7)", async () => {
    await wipeDatabase();
    const admin = await createAdmin("UuidV7Admin!2026");
    // addendum-206: clusters.organization_id is NOT NULL — anchor fixtures.
    const organizationId = await fixtureFallbackOrgId(admin.id);

    const created = [];
    for (let i = 0; i < 5; i++) {
      const cluster = {
        id: generateId(),
        name: `uuidv7-order-${i}-${Date.now()}-${Math.random()}`,
        type: "vendor" as const,
        description: null,
        organizationId,
        createdBy: admin.id,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        expiresAfter: null,
      };
      await clusters.create(cluster);
      created.push(cluster);
      // Small real delay so created_at timestamps are distinguishable —
      // without this, several rows could share the same millisecond and
      // the ordering assertion below would be trivially satisfied either way.
      await new Promise((r) => setTimeout(r, 5));
    }

    // v4 ids would sort randomly relative to insertion order; v7 ids sort
    // the same way ORDER BY id and ORDER BY created_at do, by construction.
    const sortedById = [...created].sort((a, b) => (a.id < b.id ? -1 : 1));
    assertEquals(sortedById.map((c) => c.name), created.map((c) => c.name));
  });
});
