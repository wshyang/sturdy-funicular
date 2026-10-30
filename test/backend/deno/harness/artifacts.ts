// Failure artifacts for the backend harness (addendum-081, F3) — the
// backend's answer to a Playwright screenshot: on a failing test we write
// the request log, a DB-state snapshot, and a failure.md so the moment of
// failure is inspectable instead of "assertion failed, DB wiped by the next
// file". Also callable on demand for PASSING tests (ctx.artifacts.snapshot).
//
// Addendum-103 hardened the DB snapshot in two ways:
//   1. The table allowlist now covers EVERY public table (a drift-guard step
//      in harness.test.tsx keeps it in exact-set sync with
//      information_schema, so a new table can never silently escape the
//      failure bundle).
//   2. Cell values for columns declared in config/audit_sensitive_columns.yaml
//      (the addendum-092 single source of truth for "what is sensitive") are
//      redacted to '[hidden]' — the same marker the audit trigger uses — so a
//      failure artifact never carries password hashes, TOTP secrets, nonces,
//      or app-settings secrets, even when inspected/shipped off-machine.
import { join } from "node:path";
import { query } from "../../../../server/pg.tsx";
import { loadAuditSensitivityConfig, type AuditSensitivityConfig } from "../../../../server/audit-column-sensitivity.tsx";

const ARTIFACT_ROOT = join(Deno.cwd(), "test_output", "backend", "artifacts");

// Allowlist of tables worth snapshotting. Kept explicit so the snapshot query
// can never be pointed at an arbitrary table — and kept in EXACT-set sync
// with the public schema by the drift-guard step in harness.test.tsx, so the
// completeness claim is enforced rather than aspirational.
export const SNAPSHOT_TABLES = [
  // World + lifecycle tables (the seeded topology).
  "users",
  "clusters",
  "teams",
  "team_memberships",
  "systems",
  "system_owners",
  "system_delegates",
  "team_system_mappings",
  "system_owner_pa_mappings",
  "assets",
  "asset_tags",
  "breakglass_requests",
  "request_approval_steps",
  "request_credential_items",
  "request_asset_custody_runs",
  "request_asset_custody_run_items",
  "request_asset_custody_cases",
  "asset_custody_events",
  "asset_custody_event_evidence_files",
  "asset_custody_exceptions",
  "asset_custody_exception_checks",
  "asset_custody_exception_evidence_files",
  "asset_custody_handoffs",
  "system_workflow_steps",
  "system_vendor_clusters",
  "system_custody_stage_configs",
  "organizations",
  "organization_memberships",
  // System → organisation edges (migration 084, system_org_edges_and_org_
  // consolidation). Every live system must anchor to an organisation, so a
  // failure snapshot without this table cannot show why an anchor was rejected.
  "system_organizations",
  // Auth, sessions + identity.
  "sessions",
  "login_attempts",
  "external_identities",
  "user_invites",
  "identity_change_requests",
  "idempotency_tokens",
  "admin_roles",
  "user_admin_role_grants",
  // Audit trail (parent + the generic delta child), access log + the
  // sensitivity registry itself. addendum-209 R8: the 20 per-entity
  // audit_log_* children collapsed into one generic child.
  "audit_log",
  "audit_log_changes",
  "access_log",
  "audit_sensitive_columns",
  // Config, notifications + integrations.
  "app_settings",
  "notification_templates",
  "notification_template_variables",
  "sent_notifications",
  "notification_recipients",
  "notification_deliveries",
  "notification_delivery_attempts",
  "link_mappings",
  "request_key_material",
  "aws_tenant_exchanges",
  "entra_auth_states",
  "entra_handoffs",
  "slack_auth_states",
  // Jobs + bookkeeping.
  "job_runs",
  "request_number_sequences",
  "schema_migrations",
] as const;

// The marker redacted cells are replaced with — the SAME marker the
// ffs_audit_mutation() trigger writes for masked changes, so "this value was
// deliberately withheld" reads identically across audit rows and snapshots.
export const REDACTED = "[hidden]";

// Lazily loaded + cached sensitivity config (the YAML is tiny and immutable
// within a run). Loaded from the YAML file itself — not the registry table —
// so redaction works even in a context where the sync hasn't run.
let sensitivityConfigPromise: Promise<AuditSensitivityConfig> | null = null;
function sensitivityConfig(): Promise<AuditSensitivityConfig> {
  if (!sensitivityConfigPromise) sensitivityConfigPromise = loadAuditSensitivityConfig();
  return sensitivityConfigPromise;
}

// Replaces every registry-declared sensitive column's value with REDACTED.
// Null/undefined cells are left as-is (redacting "no value" would fabricate
// the impression a secret existed and destroy diagnostic signal).
function redactRows(rows: unknown[], sensitiveColumns: readonly string[]): unknown[] {
  if (sensitiveColumns.length === 0) return rows;
  const cols = new Set(sensitiveColumns);
  return rows.map((row) => {
    if (row === null || typeof row !== "object" || Array.isArray(row)) return row;
    const out = { ...(row as Record<string, unknown>) };
    for (const col of cols) {
      if (out[col] !== null && out[col] !== undefined) out[col] = REDACTED;
    }
    return out;
  });
}

export function slugify(name: string): string {
  return name
    .replace(/[^0-9A-Za-z >_-]+/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 120);
}

function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

export interface RecordedRequest {
  method: string;
  path: string;
  body?: unknown;
  status: number;
  // Bounded copy of the response body (addendum-106, B3): verbatim when
  // small, a { __truncated, bytes, preview } envelope when over the cap —
  // "the backend answered 409 with { error: 'wrong current step' }" is the
  // single most useful failure-log line, and it used to be absent.
  response?: unknown;
  // 'step' entries (ctx.markStep, addendum-106 B4) are labeled phase
  // boundaries, not requests — the log then reads as a timeline grouped by
  // steps instead of an undifferentiated request dump.
  type?: "request" | "step";
}

// Cap for a recorded response body. Large enough that every error payload
// and typical list page fits verbatim; small enough that a 200-row export
// can't bloat a failure artifact.
const RESPONSE_BODY_CAP = 2048;

// Bounds a response body for the request log: verbatim JSON when it fits,
// a truncation envelope otherwise. Pure and exported for the self-test.
export function boundResponseBody(json: unknown): unknown {
  if (json === null || json === undefined) return null;
  const s = JSON.stringify(json);
  if (s === undefined) return null; // e.g. bare undefined
  if (s.length <= RESPONSE_BODY_CAP) return json;
  return { __truncated: true, bytes: s.length, preview: s.slice(0, RESPONSE_BODY_CAP - 48) };
}

// JSON dump of the snapshot tables (bounded: each table is capped at 200 rows
// so a runaway table can't balloon the artifact file). Sensitive columns are
// redacted per the audit_sensitive_columns.yaml registry BEFORE anything is
// returned — both the failure-bundle and the manual-snapshot paths go through
// this one choke point, so there is no unredacted path.
export async function snapshotTables(tables: string[] = SNAPSHOT_TABLES as string[]): Promise<Record<string, unknown[]>> {
  const config = await sensitivityConfig();
  const out: Record<string, unknown[]> = {};
  for (const table of tables) {
    try {
      const rows = await query(`SELECT * FROM ${table} LIMIT 200`);
      out[table] = redactRows(rows, config[table] ?? []);
    } catch {
      // A missing table (schema drift) shouldn't kill the artifact write.
      out[table] = [{ error: "table not readable" }];
    }
  }
  return out;
}

async function ensureRoot(): Promise<string> {
  await Deno.mkdir(ARTIFACT_ROOT, { recursive: true });
  return ARTIFACT_ROOT;
}

// Writes a labeled snapshot (passing tests can call this; the harness calls
// it automatically on failure). Returns the directory written.
export async function writeSnapshot(testName: string, label: string): Promise<string> {
  const dir = join(await ensureRoot(), `${slugify(testName)}`);
  await Deno.mkdir(dir, { recursive: true });
  const snap = await snapshotTables();
  const file = join(dir, `${timestamp()} (${label}).db-snapshot.json`);
  await Deno.writeTextFile(file, JSON.stringify(snap, null, 2));
  return file;
}

// Writes the full failure bundle: request-log.json + db-snapshot.json +
// failure.md. Returns the directory written.
export async function writeFailureArtifacts(opts: {
  testName: string;
  requests: RecordedRequest[];
  error: unknown;
  snapshot?: Record<string, unknown[]>;
}): Promise<string> {
  const dir = join(await ensureRoot(), `${slugify(opts.testName)}`);
  await Deno.mkdir(dir, { recursive: true });
  const stamp = timestamp();

  const requestLog = join(dir, `${stamp} (failure).request-log.json`);
  await Deno.writeTextFile(requestLog, JSON.stringify(opts.requests, null, 2));

  const snap = opts.snapshot ?? await snapshotTables();
  const snapFile = join(dir, `${stamp} (failure).db-snapshot.json`);
  await Deno.writeTextFile(snapFile, JSON.stringify(snap, null, 2));

  const message = opts.error instanceof Error ? `${opts.error.message}\n${opts.error.stack ?? ""}` : String(opts.error);
  // The last step marker (addendum-106, B4) tells the reader which labeled
  // phase the test was in when it threw — the log's step entries give the
  // full per-step request grouping.
  const stepMarkers = opts.requests.filter((r) => r.type === "step");
  const lastStep = stepMarkers.length > 0 ? stepMarkers[stepMarkers.length - 1].path : null;
  const failureMd = join(dir, `${stamp} (failure).md`);
  await Deno.writeTextFile(
    failureMd,
    `# ${opts.testName} — FAILED\n\n${message}\n\n${lastStep !== null ? `Last step marker: **${lastStep}**\n\n` : ""}See request-log.json and db-snapshot.json in this directory.\n`,
  );

  return dir;
}
