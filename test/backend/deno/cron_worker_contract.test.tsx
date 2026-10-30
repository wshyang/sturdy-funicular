// Addendum-196 static contract for the dedicated cron worker topology.
// Source-shape pins (no DB needed): the regression class this guards is
// "two process entrypoints that each grew their own registration logic" and
// "a worker that quietly starts bootstrapping/migrating in parallel" — both
// silent-schedule-drift bugs, both cheapest to catch here.
//
// Runs on the OWNER's machine (deno suites are not executed in-sandbox).
import { assert, assertEquals } from "jsr:@std/assert";

const ROOT = new URL("../../..", import.meta.url);

async function read(rel: string): Promise<string> {
  return await Deno.readTextFile(new URL(rel, ROOT));
}

Deno.test("cron worker topology contract (addendum-196)", async (t) => {
  await t.step("one shared registration source for both process topologies", async () => {
    const registration = await read("server/cron-registration.tsx");
    assert(registration.includes("export async function registerCronJobs("), "shared registration fn");
    assert(registration.includes("export function isCronEmbedded("), "embedded-mode gate lives with registration");

    const worker = await read("server/cron-worker.tsx");
    assert(worker.includes('from "./cron-registration.tsx"'), "worker registers through the shared module");

    const index = await read("server/index.tsx");
    assert(index.includes('from "./cron-registration.tsx"'), "web entrypoint imports the shared module");
    assertEquals(index.includes("for (const job of CRON_JOBS)"), false, "web entrypoint must not keep its own registration loop");
  });

  await t.step("web entrypoint gates embedded registration on CRON_EMBEDDED (default on)", async () => {
    const index = await read("server/index.tsx");
    assert(index.includes("if (isCronEmbedded())"), "embedded registration is gated");
    const registration = await read("server/cron-registration.tsx");
    assert(registration.includes('"CRON_EMBEDDED"'), "env flag named CRON_EMBEDDED");
    assert(registration.includes('?? "true"'), "default stays embedded (single-box behavior unchanged)");
  });

  await t.step("worker never bootstraps, migrates, or serves HTTP", async () => {
    const worker = await read("server/cron-worker.tsx");
    assertEquals(worker.includes("ensureSchemaApplied"), false, "schema bootstrap is the web process's job");
    assertEquals(worker.includes("runPendingMigrations"), false, "concurrent migration would double-apply SQL");
    assertEquals(worker.includes("Deno.serve"), false, "the worker exposes no attack surface");
    assertEquals(worker.includes('from "./app.tsx"'), false, "no route graph in the scheduler process");
    // …but it DOES wait for the newest migration before registering.
    assert(worker.includes("schema_migrations"), "worker gates on migration completeness");
    assert(worker.includes("Deno.exit(1)"), "boot timeout exits non-zero so the orchestrator restarts it");
  });

  await t.step("image + tasks ship the worker", async () => {
    const dockerfile = await read("Dockerfile");
    assert(dockerfile.includes("deno cache --no-check server/cron-worker.tsx"), "worker graph cached at image build");
    assertEquals(/^\s*(ENV\s+)?BREAKGLASS_ENV=DEMO\s*$/m.test(dockerfile), false, "stray DEMO-mode line stays gone (security M-addendum-196 finding)");
    const denoJson = JSON.parse(await read("deno.json")) as { tasks?: Record<string, string> };
    assert(denoJson.tasks?.["cron:worker"]?.includes("server/cron-worker.tsx") ?? false, "deno task cron:worker registered");
  });
});
