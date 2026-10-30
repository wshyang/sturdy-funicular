import { assert, assertEquals } from "jsr:@std/assert";

const SEED = new URL("../../../setup/sql/003_seed_demo_live.sql", import.meta.url);
const DEV_SEED = new URL("../../../setup/sql/002_seed_demo.sql", import.meta.url);
const SCHEMA = new URL("../../../docs/generated/database-schema.json", import.meta.url);

Deno.test("demo seed INSERT targets and columns exist in the canonical schema", async () => {
  const catalog = JSON.parse(await Deno.readTextFile(SCHEMA));
  for (const url of [DEV_SEED, SEED]) {
    const sql = await Deno.readTextFile(url);
    for (const match of sql.matchAll(/INSERT\s+INTO\s+([a-z_]+)\s*\(([^)]+)\)/gi)) {
      const tableName = match[1].toLowerCase();
      const table = catalog.tables[`public.${tableName}`];
      assert(table, `${url.pathname}: unknown INSERT table ${tableName}`);
      for (const rawColumn of match[2].split(',')) {
        const column = rawColumn.trim().replaceAll('"', '').toLowerCase();
        assert(column in table.columns, `${url.pathname}: ${tableName}.${column} is not in Drizzle schema`);
      }
    }
  }
});

Deno.test("DEMO startup seed matches canonical custody, organization, and security contracts", async () => {
  const sql = await Deno.readTextFile(SEED);
  for (const required of [
    "Org Aurora",
    "Org Cobalt",
    "amanda.scoped@aurora.demo",
    "greg.global@demo.local",
    "config_audit_admin",
    "org_structure_admin",
    "aurora-demo-client-id",
    "system_custody_stage_configs",
    "management_mode",
    "pbkdf2-sha256$600000$",
  ]) assert(sql.includes(required), `demo seed missing ${required}`);

  for (const forbidden of [
    "post_approval",
    "post_workflow",
    "attest",
    "acknowledge",
    "digest('live-demo-placeholder-not-a-real-password'",
  ]) assertEquals(sql.includes(forbidden), false, `demo seed retained ${forbidden}`);

  for (const stage of [
    "prepare",
    "initiate_handover",
    "verify_return",
    "return_to_inventory",
    "investigate_exception",
  ]) assert(sql.includes(`'${stage}'`), `demo seed missing custody stage ${stage}`);

  const configRows = sql.match(/00000000-0000-0000-0001-0000000005[3-4][0-9]/g) ?? [];
  assert(configRows.length >= 15, "three systems require five custody configurations each");
});

Deno.test("server refuses to listen before DEMO seed initialization finishes", async () => {
  const source = await Deno.readTextFile(new URL("../../../server/index.tsx", import.meta.url));
  const initialization = source.indexOf("await initializeApplication()");
  const listen = source.indexOf("Deno.serve({ port }, app.fetch)");
  assert(initialization >= 0 && listen > initialization);
  assert(source.includes("await runDemoSeedIfEnabled()"));
});

Deno.test("manual development demo seed uses current password and custody contracts", async () => {
  const sql = await Deno.readTextFile(DEV_SEED);
  assert(sql.includes("pbkdf2-sha256$600000$"));
  assert(sql.includes("organization_memberships"));
  assert(sql.includes("system_custody_stage_configs"));
  assertEquals(sql.includes("digest(password"), false);
  assertEquals(sql.includes("post_approval"), false);
});
