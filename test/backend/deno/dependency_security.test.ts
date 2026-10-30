import { assert, assertEquals } from "jsr:@std/assert";

Deno.test("security dependency floor and backend npm pins stay aligned", async () => {
  const packageJson = JSON.parse(await Deno.readTextFile(new URL("../../../package.json", import.meta.url)));
  assertEquals(packageJson.dependencies["drizzle-orm"], "^0.45.2");
  assertEquals(packageJson.dependencies["react-router"], "^7.18.2");
  assertEquals(packageJson.devDependencies.nodemailer, "^9.0.5");
  assertEquals(packageJson.devDependencies.vite, "^6.4.3");

  const serverRoot = new URL("../../../server/", import.meta.url);
  for await (const entry of walk(serverRoot)) {
    if (!entry.pathname.endsWith(".ts") && !entry.pathname.endsWith(".tsx")) continue;
    const source = await Deno.readTextFile(entry);
    assertEquals(source.includes("npm:drizzle-orm@0.33.0"), false, entry.pathname);
    assertEquals(source.includes("npm:nodemailer@6"), false, entry.pathname);
  }

  const smtp = await Deno.readTextFile(new URL("../../../server/email/smtp.tsx", import.meta.url));
  assert(smtp.includes("disableFileAccess: true"));
  assert(smtp.includes("disableUrlAccess: true"));
});

async function* walk(directory: URL): AsyncGenerator<URL> {
  for await (const entry of Deno.readDir(directory)) {
    const child = new URL(entry.name + (entry.isDirectory ? "/" : ""), directory);
    if (entry.isDirectory) yield* walk(child);
    else if (entry.isFile) yield child;
  }
}
