// Unit tests for the test-harness name pools (test/backend/deno/name-seeds.ts).
import { assertEquals, assertNotEquals } from "jsr:@std/assert";
import { singaporeanName, vendorName, nameForAffiliation } from "./name-seeds.ts";

const SG_GIVEN = [
  // SG_CHINESE first tokens
  "Wei", "Jia", "Yu", "Kai", "Hui", "Zhi", "Xin", "Jun", "Mei", "Si", "Yong", "Pei",
  // SG_MALAY (single-word given names)
  "Muhammad", "Nurul", "Aisyah", "Farhan", "Siti", "Amir", "Hafiz", "Nadia", "Syafiq", "Aminah", "Rizwan", "Aqilah",
  // SG_INDIAN (single-word given names)
  "Arun", "Priya", "Rajesh", "Divya", "Karthik", "Meena", "Suresh", "Lakshmi", "Vijay", "Anjali", "Ravi", "Sangeetha",
];
const VENDOR_GIVEN = [
  // INDIAN
  "Amit", "Neha", "Rahul", "Pooja", "Sandeep", "Anita", "Vikram", "Kavita", "Sanjay", "Ritu", "Deepak", "Shalini",
  // FILIPINO
  "Maria", "Jose", "Juan", "Ana", "Miguel", "Rosa", "Antonio", "Liza", "Ramon", "Carmen", "Pedro", "Elena",
];

Deno.test("name-seeds: singaporeanName returns a plausible two-token full name", () => {
  const name = singaporeanName();
  assertEquals(typeof name, "string");
  // At least a given + a surname.
  assertEquals(name.split(" ").length >= 2, true);
});

Deno.test("name-seeds: vendorName returns an Indian or Filipino full name", () => {
  const name = vendorName();
  assertEquals(typeof name, "string");
  assertEquals(name.split(" ").length >= 2, true);
});

Deno.test("name-seeds: singaporean names come from the three SG ethnic pools", () => {
  for (let i = 0; i < 200; i++) {
    const given = singaporeanName().split(" ")[0];
    assertEquals(SG_GIVEN.includes(given), true, `unexpected SG given name: ${given}`);
  }
});

Deno.test("name-seeds: vendor names come from the Indian/Filipino pools", () => {
  for (let i = 0; i < 200; i++) {
    const given = vendorName().split(" ")[0];
    assertEquals(VENDOR_GIVEN.includes(given), true, `unexpected vendor given name: ${given}`);
  }
});

Deno.test("name-seeds: nameForAffiliation routes agency->SG, vendor->Indian/Filipino", () => {
  const agency = nameForAffiliation("agency");
  const vendor = nameForAffiliation("vendor");
  assertEquals(SG_GIVEN.includes(agency.split(" ")[0]), true);
  assertEquals(VENDOR_GIVEN.includes(vendor.split(" ")[0]), true);
});

Deno.test("name-seeds: names vary across calls (random selection)", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 50; i++) seen.add(singaporeanName());
  assertNotEquals(seen.size, 1);
});
