// Schema-snapshot ⇄ migrations convergence suite (addendum-079).
//
// The repo's SQL standing rule (CLAUDE-standing-rules.md) requires
// `setup/sql/001_schema.sql` to be a WHOLESALE snapshot of the complete
// current schema/seed shape, while `migrations/NNN_*.sql` are the
// incremental changelog that upgrades already-provisioned databases. The two
// must never drift: a change that lands in one but not the other produces a
// fresh-install database that differs from an upgraded database — the exact
// failure class that caused the app-settings 500 (addendum-070).
//
// This file enforces convergence in two complementary ways:
//
//   1. STATIC invariants (no database needed):
//      - 001_schema.sql contains no ALTER TABLE / ALTER TYPE (it must be the
//        current shape, never a patch).
//      - Every migration file is well-formed (BEGIN/COMMIT) and registers its
//        own NNN version in schema_migrations.
//      - Migration version numbers are contiguous (001..NNN).
//      - 001's schema_migrations pre-seed covers EXACTLY the migration
//        versions ≤ its baseline (so a migration added inside the pre-seeded
//        range without being folded into the snapshot is caught), and every
//        pre-seeded version has a migration file.
//
//   2. DB convergence probe (needs Postgres, like the rest of this suite):
//      - Probe A: provision a scratch database from 001_schema.sql ONLY.
//      - Probe B: provision a scratch database from 001_schema.sql, then
//        force-apply EVERY migration file in order (migrations must be
//        idempotent no-ops on top of the current snapshot by design).
//      - Compare a normalized catalog fingerprint (tables/columns/enums/
//        indexes/constraints/triggers/functions/views/sequences + the seeded
//        config rows) of the two databases; any difference is a snapshot⇄
//        migration drift failure.
//
// The probe creates two throwaway databases (ffs_schema_probe_a/_b) via
// CREATE DATABASE, so it requires a role with CREATEDB (the postgres
// superuser the test DATABASE_URL points at in docker-compose / CI). It
// never touches the shared breakglass_test schema.
import { assertEquals, assert, assertMatch } from "jsr:@std/assert";
import { Pool } from "jsr:@db/postgres";

const MIGRATIONS_DIR = new URL("../../../migrations/", import.meta.url);
const SNAPSHOT_PATH = new URL("../../../setup/sql/001_schema.sql", import.meta.url);

const PROBE_A = "ffs_schema_probe_a";
const PROBE_B = "ffs_schema_probe_b";

function listSqlFiles(): string[] {
  const out: string[] = [];
  for (const entry of Deno.readDirSync(MIGRATIONS_DIR)) {
    if (entry.isFile && entry.name.endsWith(".sql")) out.push(entry.name);
  }
  return out.sort();
}

function versionOf(filename: string): number {
  return parseInt(filename.split("_")[0], 10);
}

// Function bodies may differ cosmetically between the snapshot and a
// migration copy (comment wording, whitespace, `$$` vs `$function$`). Strip
// line comments and collapse whitespace (and normalize the body delimiter)
// so the comparison is about the SQL logic, not prose.
function normalizeFunctionDef(def: string): string {
  return def
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join(" ")
    .replace(/\$\$|\$[A-Za-z_]*\$/g, "$BODY$")
    .replace(/\s+/g, " ")
    .trim();
}

// ============================================================================
// 1. STATIC INVARIANTS (no database required)
// ============================================================================

Deno.test("schema_snapshot_vs_migrations: static invariants (no DB)", async (t) => {
  const snapshot = await Deno.readTextFile(SNAPSHOT_PATH);
  const files = listSqlFiles();
  const versions = files.map(versionOf);
  const uniqueVersions = new Set(versions);

  await t.step("001_schema.sql is a wholesale snapshot — no ALTER TABLE / ALTER TYPE", () => {
    const alters = snapshot
      .split("\n")
      .filter((line) => /^\s*ALTER\s+(TABLE|TYPE)\b/i.test(line));
    assertEquals(
      alters,
      [],
      "001_schema.sql must contain no ALTER TABLE/ALTER TYPE — the standing rule (addendum-026) requires every change to land in the CREATE TABLE blocks, not as a patch on the snapshot.",
    );
  });

  // Addendum-213: migrations/ was squashed to empty (first-deploy reset, no
  // real deployment existed yet to protect against double-applying). With
  // zero files there is no trail to check for contiguity, well-formedness,
  // or pre-seed alignment — those invariants resume meaning once a NEXT
  // migration (002+) is added on top of this clean baseline.
  if (files.length === 0) {
    await t.step("001's schema_migrations pre-seed is the single first-deploy marker row (no migration trail to fold)", () => {
      assertMatch(
        snapshot,
        /INSERT INTO schema_migrations[\s\S]*?VALUES\s*\(\s*'001'/,
        "001_schema.sql must seed its own '001' baseline marker row in schema_migrations",
      );
    });
    return;
  }

  await t.step("migration version numbers are contiguous (no gaps)", () => {
    const minV = Math.min(...versions);
    const maxV = Math.max(...versions);
    for (let v = minV; v <= maxV; v++) {
      assert(uniqueVersions.has(v), `missing migration version ${String(v).padStart(3, "0")}`);
    }
  });

  await t.step("every migration file is well-formed and registers its own version", async () => {
    for (const f of files) {
      const sql = await Deno.readTextFile(new URL(f, MIGRATIONS_DIR));
      const v = String(versionOf(f)).padStart(3, "0");
      assertMatch(
        sql,
        new RegExp(`INSERT INTO schema_migrations[\\s\\S]*?VALUES\\s*\\(\\s*'${v}'`),
        `${f} must register its own version ${v} in schema_migrations`,
      );
      assert((sql.match(/^\s*BEGIN\s*;/m)?.length ?? 0) >= 1, `${f} must open with BEGIN`);
      assert((sql.match(/^\s*COMMIT\s*;/m)?.length ?? 0) >= 1, `${f} must close with COMMIT`);
    }
  });

  await t.step("001's schema_migrations pre-seed exactly matches the folded-in migration set", () => {
    const m = snapshot.match(/FROM unnest\(ARRAY\[([\s\S]*?)\]\)/);
    assert(m, "001_schema.sql must pre-seed schema_migrations from an unnest ARRAY block");
    const preseed = [...m[1].matchAll(/'(\d+)'/g)].map((x) => parseInt(x[1], 10));
    // Contiguous.
    for (let i = 1; i < preseed.length; i++) {
      assertEquals(preseed[i], preseed[i - 1] + 1, "001's pre-seed list must be contiguous");
    }
    const preseedSet = new Set(preseed);
    const maxPre = preseed[preseed.length - 1];

    // Every migration version ≤ the baseline must be folded into the snapshot
    // (i.e. pre-seeded) — otherwise an old DB migrating forward would apply a
    // migration whose effect the snapshot already contains, or a fresh DB
    // would re-run it and potentially clobber the snapshot (e.g. migration 023
    // restoring an older trigger body).
    for (const v of uniqueVersions) {
      if (v <= maxPre) {
        assert(preseedSet.has(v), `migration ${String(v).padStart(3, "0")} (≤ pre-seed baseline ${maxPre}) is not folded into 001_schema.sql — pre-seed it or renumber it above the baseline`);
      } else {
        assert(!preseedSet.has(v), `migration ${String(v).padStart(3, "0")} is pre-seeded but sits ABOVE the baseline ${maxPre} — pre-seeding means it would never run`);
      }
    }
    // Every pre-seeded version must correspond to a real migration file.
    for (const v of preseed) {
      assert(uniqueVersions.has(v), `pre-seeded version ${String(v).padStart(3, "0")} has no migration file`);
    }
  });
});

// ============================================================================
// 2. DB CONVERGENCE PROBE (requires Postgres — run via `deno task test`)
// ============================================================================

async function probeUrl(db: string): Promise<string> {
  const base = Deno.env.get("DATABASE_URL");
  if (!base) throw new Error("DATABASE_URL is not set — run this suite via `deno task test` with Postgres up.");
  const u = new URL(base);
  u.pathname = `/${db}`;
  return u.toString();
}

// Drop (terminating stragglers) then re-create both probe databases. Needs a
// role with CREATEDB — the postgres superuser the test DATABASE_URL uses.
async function resetProbeDatabases(baseUrl: string): Promise<void> {
  const pool = new Pool(baseUrl, 1, true);
  try {
    const c = await pool.connect();
    try {
      for (const db of [PROBE_A, PROBE_B]) {
        await c.queryObject({
          text: `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${db}' AND pid <> pg_backend_pid()`,
        });
        await c.queryObject({ text: `DROP DATABASE IF EXISTS ${db}` });
        await c.queryObject({ text: `CREATE DATABASE ${db}` });
      }
    } finally {
      c.release();
    }
  } finally {
    await pool.end().catch(() => {});
  }
}

// Execute an entire SQL file (multi-statement, BEGIN/COMMIT included) against
// a probe database — the same simple-protocol path server/migrate.tsx uses.
async function applySqlToProbe(db: string, sql: string): Promise<void> {
  const pool = new Pool(await probeUrl(db), 4, true);
  try {
    const c = await pool.connect();
    try {
      await c.queryObject({ text: sql });
    } finally {
      c.release();
    }
  } finally {
    await pool.end().catch(() => {});
  }
}

// Build a normalized, order-stable fingerprint of a probe database's schema
// + seeded config rows. Each category is a sorted list of stable strings so
// the two probes can be compared for exact equality.
async function captureFingerprint(db: string): Promise<Record<string, string[]>> {
  const pool = new Pool(await probeUrl(db), 4, true);
  try {
    const c = await pool.connect();
    try {
      const q = async (sql: string): Promise<any[]> => {
        const r = await c.queryObject({ text: sql });
        return (r as any).rows as any[];
      };
      const out: Record<string, string[]> = {};

      // Tables + columns (+ defaults / identity / generated).
      out["tables"] = (await q(`SELECT c.relname AS tbl, a.attname AS col,
             format_type(a.atttypid, a.atttypmod) AS typ,
             a.attnotnull AS notnull,
             a.attidentity AS identity,
             a.attgenerated AS generated,
             pg_get_expr(d.adbin, d.adrelid) AS def
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
           JOIN pg_attribute a ON a.attrelid = c.oid
           LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
           WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
             AND a.attnum > 0 AND NOT a.attisdropped
           ORDER BY c.relname, a.attnum`)).map((r) =>
        `${r.tbl}|${r.col}|${r.typ}|${r.notnull}|${r.identity}|${r.generated}|${r.def ?? ""}`);

      // Enums (labels in declaration order).
      out["enums"] = (await q(`SELECT t.typname, array_agg(e.enumlabel ORDER BY e.enumsortorder) AS labels
           FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
           JOIN pg_namespace n ON n.oid = t.typnamespace
           WHERE n.nspname = 'public' GROUP BY t.typname ORDER BY t.typname`)).map((r) =>
        `${r.typname}|${(r.labels as string[]).join(",")}`);

      // Indexes.
      out["indexes"] = (await q(`SELECT c.relname AS tbl, i.relname AS name, pg_get_indexdef(i.oid) AS def
           FROM pg_index ix JOIN pg_class i ON i.oid = ix.indexrelid
           JOIN pg_class c ON c.oid = ix.indrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND ix.indisvalid
           ORDER BY i.relname`)).map((r) => `${r.tbl}|${r.name}|${r.def}`);

      // Constraints.
      out["constraints"] = (await q(`SELECT c.conname, c.conrelid::regclass::text AS tbl, pg_get_constraintdef(c.oid) AS def
           FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
           WHERE n.nspname = 'public' ORDER BY c.conname, c.conrelid::regclass::text`)).map((r) =>
        `${r.tbl}|${r.conname}|${r.def}`);

      // Triggers (non-internal).
      out["triggers"] = (await q(`SELECT t.tgname, c.relname AS tbl, pg_get_triggerdef(t.oid) AS def
           FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND NOT t.tgisinternal
           ORDER BY t.tgname, c.relname`)).map((r) => `${r.tbl}|${r.tgname}|${r.def}`);

      // Functions / procedures (comment- and whitespace-normalized).
      out["functions"] = (await q(`SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args, pg_get_functiondef(p.oid) AS def
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND p.prokind IN ('f','p')
           ORDER BY p.proname, pg_get_function_identity_arguments(p.oid)`)).map((r) =>
        `${r.proname}(${r.args})|${normalizeFunctionDef(r.def)}`);

      // Views + sequences (both empty today; kept so a future addition is caught).
      out["views"] = (await q(`SELECT c.relname, pg_get_viewdef(c.oid) AS def
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relkind = 'v' ORDER BY c.relname`)).map((r) => `${r.relname}|${r.def}`);
      out["sequences"] = (await q(`SELECT c.relname
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relkind = 'S' ORDER BY c.relname`)).map((r) => `${r.relname}`);

      // Seeded config rows (stable columns only — timestamps/audit columns
      // differ between the two probes by construction and are excluded).
      // schema_migrations is deliberately excluded: a fresh 001-only DB
      // records 001..033 while the migrated probe records 001..041 — the
      // pre-seed vs applied-set difference is expected by design (asserted
      // statically above instead).
      out["seeds.app_settings"] = (await q(
        `SELECT key, value, value_type, category, description, is_secret::text AS is_secret FROM public.app_settings ORDER BY key`,
      )).map((r) => `${r.key}|${r.value}|${r.value_type}|${r.category}|${r.description}|${r.is_secret}`);

      out["seeds.admin_roles"] = (await q(
        `SELECT id::text AS id, key, name, description, is_system_role::text AS sr, capabilities::text AS caps FROM public.admin_roles ORDER BY key`,
      )).map((r) => `${r.id}|${r.key}|${r.name}|${r.description}|${r.sr}|${r.caps}`);

      out["seeds.notification_templates"] = (await q(
        `SELECT nt.trigger_key::text AS tk, nt.subject, nt.body_html, coalesce(string_agg(ntv.name || ':' || ntv.description, ',' ORDER BY ntv.ordinal),'') AS vars, nt.is_active::text AS act FROM public.notification_templates nt LEFT JOIN public.notification_template_variables ntv ON ntv.template_id=nt.id GROUP BY nt.id ORDER BY tk`,
      )).map((r) => `${r.tk}|${r.subject}|${r.body_html}|${r.vars}|${r.act}`);

      out["seeds.users_reserved"] = (await q(
        `SELECT id::text AS id, full_name, email, COALESCE(affiliation::text,'') AS aff, status::text AS st, is_system::text AS sys, is_protected::text AS prot
         FROM public.users WHERE is_system OR is_protected ORDER BY id`,
      )).map((r) => `${r.id}|${r.full_name}|${r.email}|${r.aff}|${r.st}|${r.sys}|${r.prot}`);

      return out;
    } finally {
      c.release();
    }
  } finally {
    await pool.end().catch(() => {});
  }
}

Deno.test("schema_snapshot_vs_migrations: DB convergence — applying all migrations on top of the snapshot is a schema no-op", async (t) => {
  const baseUrl = Deno.env.get("DATABASE_URL");
  if (!baseUrl) throw new Error("DATABASE_URL is not set — run via `deno task test` with Postgres up.");

  await resetProbeDatabases(baseUrl);
  const snapshot = await Deno.readTextFile(SNAPSHOT_PATH);
  const files = listSqlFiles();

  try {
    await t.step("probe A: provision a scratch DB from the snapshot ONLY", async () => {
      await applySqlToProbe(PROBE_A, snapshot);
    });

    await t.step("probe B: provision from the snapshot, then force-apply EVERY migration in order", async () => {
      await applySqlToProbe(PROBE_B, snapshot);
      for (const f of files) {
        await applySqlToProbe(PROBE_B, await Deno.readTextFile(new URL(f, MIGRATIONS_DIR)));
      }
    });

    await t.step("the two schemas converge (identical normalized fingerprint)", async () => {
      const fa = await captureFingerprint(PROBE_A);
      const fb = await captureFingerprint(PROBE_B);

      const diverged = Object.keys(fa).filter((k) => JSON.stringify(fa[k]) !== JSON.stringify(fb[k]));
      assertEquals(
        diverged,
        [],
        `Schema drift between the snapshot-only DB and the snapshot+migrations DB in: ${diverged.join(", ")}. ` +
          `This means 001_schema.sql and the migration trail disagree — fold the change into BOTH the snapshot and ` +
          `a migration (see addendum-079).`,
      );
      // Surface the actual per-category diff for the first divergence.
      for (const k of diverged) {
        assertEquals(fb[k], fa[k], `category ${k} diverged`);
      }
    });
  } finally {
    await resetProbeDatabases(baseUrl).catch(() => {});
  }
});
