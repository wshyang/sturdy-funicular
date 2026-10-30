// State-assertion helpers for the backend harness (addendum-081, F5) — the
// `expect` analog: encode the repo's positive + session-scoping-negative
// discipline as one-liners instead of raw assertEquals plumbing. All queries
// go through the real DB (no mocks) and table names are allowlisted.
import { query } from "../../../../server/pg.tsx";
import { getSessionUser } from "../../../../server/auth.tsx";
import { SNAPSHOT_TABLES } from "./artifacts.ts";

const ALLOWED_TABLES = new Set<string>(SNAPSHOT_TABLES as string[]);

// Builds an equality filter. `connector` is the leading keyword ("WHERE" for a
// standalone clause, "AND" when appended to an existing WHERE) and `offset` is
// the number of placeholders already consumed by the caller ($1..$offset), so
// the generated placeholders continue from $offset+1.
function buildWhere(
  table: string,
  where: Record<string, unknown>,
  connector: "WHERE" | "AND" = "WHERE",
  offset = 0,
): { clause: string; args: unknown[] } {
  const keys = Object.keys(where);
  if (keys.length === 0) return { clause: "", args: [] };
  const clause = `${connector} ` + keys.map((k, i) => `${k} = $${offset + i + 1}`).join(" AND ");
  return { clause, args: keys.map((k) => where[k]) };
}

export class Assertions {
  // Count rows in an allowlisted table with an optional equality filter.
  async rowCount(table: string, where: Record<string, unknown> = {}): Promise<number> {
    if (!ALLOWED_TABLES.has(table)) throw new Error(`rowCount: table not allowlisted: ${table}`);
    const { clause, args } = buildWhere(table, where);
    const rows = await query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} ${clause}`, args);
    return rows[0]?.n ?? 0;
  }

  // True iff the token resolves to a live session (the gate's getSession path).
  async sessionValid(token: string): Promise<boolean> {
    return (await getSessionUser(token)) !== null;
  }

  // True iff at least one audit_log row matches the action (+ optional filter).
  async auditHas(action: string, where: Record<string, unknown> = {}): Promise<boolean> {
    // action already occupies $1; the optional filter must append with AND and
    // continue placeholders from $2 (offset 1).
    const { clause, args } = buildWhere("audit_log", where, "AND", 1);
    const rows = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_log WHERE action = $1 ${clause}`,
      [action, ...args],
    );
    return (rows[0]?.n ?? 0) > 0;
  }

  // Count sent_notifications rows for a trigger (the notification fan-out helper).
  async notificationsFor(trigger: string): Promise<number> {
    const rows = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM sent_notifications WHERE trigger_key = $1`,
      [trigger],
    );
    return rows[0]?.n ?? 0;
  }
}
