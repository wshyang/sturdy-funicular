// Addendum-147 RED-first schema/domain contract for the multichannel root.
import { assert, assertEquals } from "jsr:@std/assert";
import { query } from "../../../server/pg.tsx";

Deno.test('sent notifications root is channel-neutral and every child has enforced FKs', async () => {
  const old = await query<{ reg: string | null }>(`SELECT to_regclass('public.sent_emails')::text AS reg`);
  assertEquals(old[0]?.reg ?? null, null);
  const columns = await query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='sent_notifications' ORDER BY ordinal_position`);
  const names = columns.map((row) => row.column_name);
  for (const required of ['id','trigger_key','rendered_subject','rendered_body_html','rendered_body_text','related_target_type','related_target_id','created_at']) assert(names.includes(required));
  for (const forbidden of ['status','provider','provider_message_id','recipient_emails']) assert(!names.includes(forbidden));

  for (const [table, minimum] of [['notification_recipients',2],['notification_deliveries',1],['notification_delivery_attempts',1]] as const) {
    const [row] = await query<{ n: number }>(`SELECT count(*)::int AS n FROM information_schema.table_constraints WHERE table_schema='public' AND table_name=$1 AND constraint_type='FOREIGN KEY'`,[table]);
    assert((row?.n ?? 0) >= minimum, `${table} must expose its real parent/user FKs`);
  }
  const deliveryColumns = await query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema='public' AND table_name='notification_deliveries'`,
  );
  const deliveryColumnNames = deliveryColumns.map((row) => row.column_name);
  for (const required of [
    'attempt_count',
    'next_attempt_at',
    'claimed_at',
    'claimed_by',
    'last_attempt_at',
  ]) {
    assert(deliveryColumnNames.includes(required), `missing outbox column ${required}`);
  }

  const unique = await query(`SELECT 1 FROM pg_indexes WHERE schemaname='public' AND tablename='notification_deliveries' AND indexdef ILIKE '%notification_recipient_id%channel%'`);
  assert(unique.length > 0,'one logical delivery per recipient/channel must be unique');
  const dueIndex = await query(
    `SELECT 1 FROM pg_indexes
     WHERE schemaname='public' AND tablename='notification_deliveries'
       AND indexname='notification_deliveries_pending_due_idx'`,
  );
  assert(dueIndex.length > 0, 'pending outbox claims need a due-work partial index');
});
