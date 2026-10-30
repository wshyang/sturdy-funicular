// Coverage: deriveRoleBaseName's leading "ffs-test-" prefix-stripping logic
// (server/aws-ssm.tsx) — pure logic, no AWS/DB dependency, so no
// wipeDatabase()/fixture setup is needed here. See
// addendum-038-cfn-namespace-prefix-rename.md, which moved this function
// from stripping a trailing "-test" suffix to a leading "ffs-test-" prefix,
// matching infra/cloudformation/test-secret-autorelease.yaml's renamed
// AssumeRoleTest resource.
import { assertEquals } from "jsr:@std/assert";
import { deriveRoleBaseName } from "../../../server/aws/ssm.tsx";

Deno.test("aws-ssm: deriveRoleBaseName", async (t) => {
  await t.step("strips a leading ffs-test- prefix, matching the CFN template's AssumeRoleTest naming", () => {
    assertEquals(
      deriveRoleBaseName("arn:aws:iam::123456789012:role/ffs-test-foo"),
      "foo",
    );
  });

  await t.step("passes through unchanged when the role name has no ffs-test- prefix — this project's own LocalStack fixture role", () => {
    assertEquals(
      deriveRoleBaseName("arn:aws:iam::000000000000:role/ffs-e2e-assume-role"),
      "ffs-e2e-assume-role",
    );
  });

  await t.step("does not strip a bare trailing -test suffix — the old convention this replaced", () => {
    assertEquals(
      deriveRoleBaseName("arn:aws:iam::123456789012:role/foo-test"),
      "foo-test",
    );
  });
});
