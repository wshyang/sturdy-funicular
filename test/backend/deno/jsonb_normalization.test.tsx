// Addendum-146 RED-first schema contract: business JSONB is forbidden; only
// explicitly retained heterogeneous observability documents may remain.
import { assert, assertEquals } from "jsr:@std/assert";
import { query } from "../../../server/pg.tsx";

const ALLOWED = new Set([
  'access_log.request_headers',
  'audit_log.details',
  // addendum-209 R8: the 20 per-entity audit_log_* children collapsed into one
  // generic child — the only remaining audit delta JSONB column.
  'audit_log_changes.changes',
]);

Deno.test('all business JSONB columns are normalized with FK-backed replacements', async () => {
  const rows = await query<{ table_name: string; column_name: string }>(`
    SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND data_type = 'jsonb'
    ORDER BY table_name, ordinal_position`);
  const actual = new Set(rows.map((row) => `${row.table_name}.${row.column_name}`));
  assertEquals(actual, ALLOWED);

  const requiredTables = [
    'system_vendor_clusters', 'system_workflow_steps', 'asset_tags',
    'request_asset_custody_run_items',
    'notification_template_variables', 'notification_recipients',
  ];
  for (const table of requiredTables) {
    const [count] = await query<{ n: number }>(`SELECT count(*)::int AS n FROM information_schema.table_constraints WHERE table_schema='public' AND table_name=$1 AND constraint_type='FOREIGN KEY'`, [table]);
    assert((count?.n ?? 0) > 0, `${table} must have at least one real FK`);
  }
});
