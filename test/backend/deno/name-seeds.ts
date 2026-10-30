// Realistic fixture-name pools for test harness users.
//
// Purpose: instead of anonymous "user-123" labels, seed fixture users with
// plausible, distinct real-world names so test data reads naturally and
// e2e/backend assertions on displayed names stay human-meaningful. Two pools
// deliberately mirror the product's affiliation split:
//   - AGENCY users (public officers) → Singaporean names (Chinese, Malay, Indian).
//   - VENDOR users → Indian and Filipino names.
//
// This is test-only data. Names are real-ish but generic; they are never used
// to contact anyone and never leave the test database.

const SEQ = { seq: 0 };

function nextSeq(): number {
  SEQ.seq += 1;
  return SEQ.seq;
}

// ── Singaporean name pool (agency users) ────────────────────────────────────
// Chinese (Singapore), Malay, and Indian given+surname pairs.
const SG_CHINESE = {
  given: ["Wei Ming", "Jia Hui", "Yu Xin", "Kai Wen", "Hui Min", "Zhi Hao", "Xin Yi", "Jun Wei", "Mei Ling", "Si Yuan", "Yong Sheng", "Pei Qi"],
  surname: ["Tan", "Lim", "Lee", "Ng", "Ong", "Wong", "Goh", "Chua", "Teo", "Yeoh", "Koh", "Liew"],
};
const SG_MALAY = {
  given: ["Muhammad", "Nurul", "Aisyah", "Farhan", "Siti", "Amir", "Hafiz", "Nadia", "Syafiq", "Aminah", "Rizwan", "Aqilah"],
  surname: ["bin Ahmad", "binti Abdullah", "bin Ismail", "binti Hassan", "bin Yusof", "binti Rahman", "bin Osman", "binti Zainal", "bin Bakar", "binti Omar", "bin Hashim", "binti Ibrahim"],
};
const SG_INDIAN = {
  given: ["Arun", "Priya", "Rajesh", "Divya", "Karthik", "Meena", "Suresh", "Lakshmi", "Vijay", "Anjali", "Ravi", "Sangeetha"],
  surname: ["Kumar", "Nair", "Pillai", "Menon", "Iyer", "Rao", "Sundaram", "Krishnan", "Murthy", "Venkatesh", "Raman", "Subramaniam"],
};

// ── Indian + Filipino name pool (vendor users) ──────────────────────────────
const INDIAN = {
  given: ["Amit", "Neha", "Rahul", "Pooja", "Sandeep", "Anita", "Vikram", "Kavita", "Sanjay", "Ritu", "Deepak", "Shalini"],
  surname: ["Sharma", "Patel", "Reddy", "Gupta", "Singh", "Verma", "Chopra", "Mehta", "Joshi", "Bhat", "Kulkarni", "Nair"],
};
const FILIPINO = {
  given: ["Maria", "Jose", "Juan", "Ana", "Miguel", "Rosa", "Antonio", "Liza", "Ramon", "Carmen", "Pedro", "Elena"],
  surname: ["Santos", "Reyes", "Cruz", "Bautista", "Ocampo", "Garcia", "Mendoza", "Torres", "Ramos", "Aquino", "Navarro", "De la Cruz"],
};

function pick<T>(arr: T[]): T {
  const item = arr[Math.floor(Math.random() * arr.length)];
  if (item === undefined) throw new Error('pick: empty source array');
  return item;
}

// A Singaporean full name — randomly one of the three main ethnic groups.
export function singaporeanName(): string {
  const group = pick([SG_CHINESE, SG_MALAY, SG_INDIAN]);
  return `${pick(group.given)} ${pick(group.surname)}`.replace(/\s+/g, " ").trim();
}

// An Indian or Filipino full name (vendor pool).
export function vendorName(): string {
  const group = pick([INDIAN, FILIPINO]);
  return `${pick(group.given)} ${pick(group.surname)}`;
}

// Affiliation-aware fixture name: agency users get Singaporean names, vendor
// users get Indian/Filipino names. Any other affiliation falls back to a
// generic labelled name.
export function nameForAffiliation(affiliation: string, label = "User"): string {
  if (affiliation === "agency") return singaporeanName();
  if (affiliation === "vendor") return vendorName();
  return `${label} ${nextSeq()}`;
}
