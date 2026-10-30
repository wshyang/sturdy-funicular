// GET /owner/statistics — the range-validation arms behind §E's Statistics
// story (the inverted-range refusal the element suite pins client-side,
// backed here at the route): owner.test.tsx drives only the positive
// breakdowns.
import { assertEquals } from "jsr:@std/assert";
import { req, authHeaders, createActiveUser, loginAs, uniqueEmail } from "../helpers.tsx";
import type { SuiteContext } from "./00-context.ts";

export async function run02Steps(t: Deno.TestContext, context: SuiteContext): Promise<void> {
  const { ownerSession } = context;

  await t.step("statistics: negative — missing from/to rejected 400", async () => {
    const res = await req("/owner/statistics", { headers: authHeaders(ownerSession) });
    assertEquals(res.status, 400);
    const body = await res.json();
    assertEquals(body.error, "from and to are required.");
  });

  await t.step("statistics: negative — an unparseable range rejected 400", async () => {
    const res = await req("/owner/statistics?from=not-a-date&to=2026-02-01T00%3A00%3A00.000Z", {
      headers: authHeaders(ownerSession),
    });
    assertEquals(res.status, 400);
    const body = await res.json();
    assertEquals(body.error, "Invalid date range.");
  });

  await t.step("statistics: negative — an INVERTED range rejected 400 (to <= from)", async () => {
    const res = await req(
      "/owner/statistics?from=2026-02-01T00%3A00%3A00.000Z&to=2026-01-01T00%3A00%3A00.000Z",
      { headers: authHeaders(ownerSession) },
    );
    assertEquals(res.status, 400);
    const body = await res.json();
    assertEquals(body.error, "Invalid date range.");
  });

  await t.step("statistics: positive edge — an owner of NOTHING gets the empty 200 shape, not an error", async () => {
    const nobody = await createActiveUser({ fullName: "NoSystems", email: uniqueEmail("og-nosys"), password: "NoSysPass!2026", affiliation: "agency" });
    const login = await loginAs(nobody.email, "NoSysPass!2026");
    const res = await req(
      "/owner/statistics?from=2026-01-01T00%3A00%3A00.000Z&to=2026-02-01T00%3A00%3A00.000Z",
      { headers: authHeaders((login as any).session) },
    );
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.mode, "by_system");
    assertEquals(body.systemId, null);
    assertEquals(body.data, []);
  });
}
