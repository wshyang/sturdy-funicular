//! Realistic fixture-name pools (port of test/backend/deno/name-seeds.ts).
//! Agency users get Singaporean names; vendor users get Indian/Filipino names.

use rand::seq::SliceRandom;
use std::sync::atomic::{AtomicU64, Ordering};

struct Pool {
    given: &'static [&'static str],
    surname: &'static [&'static str],
}

const SG_CHINESE: Pool = Pool {
    given: &["Wei Ming", "Jia Hui", "Yu Xin", "Kai Wen", "Hui Min", "Zhi Hao", "Xin Yi", "Jun Wei", "Mei Ling", "Si Yuan", "Yong Sheng", "Pei Qi"],
    surname: &["Tan", "Lim", "Lee", "Ng", "Ong", "Wong", "Goh", "Chua", "Teo", "Yeoh", "Koh", "Liew"],
};
const SG_MALAY: Pool = Pool {
    given: &["Muhammad", "Nurul", "Aisyah", "Farhan", "Siti", "Amir", "Hafiz", "Nadia", "Syafiq", "Aminah", "Rizwan", "Aqilah"],
    surname: &["bin Ahmad", "binti Abdullah", "bin Ismail", "binti Hassan", "bin Yusof", "binti Rahman", "bin Osman", "binti Zainal", "bin Bakar", "binti Omar", "bin Hashim", "binti Ibrahim"],
};
const SG_INDIAN: Pool = Pool {
    given: &["Arun", "Priya", "Rajesh", "Divya", "Karthik", "Meena", "Suresh", "Lakshmi", "Vijay", "Anjali", "Ravi", "Sangeetha"],
    surname: &["Kumar", "Nair", "Pillai", "Menon", "Iyer", "Rao", "Sundaram", "Krishnan", "Murthy", "Venkatesh", "Raman", "Subramaniam"],
};
const INDIAN: Pool = Pool {
    given: &["Amit", "Neha", "Rahul", "Pooja", "Sandeep", "Anita", "Vikram", "Kavita", "Sanjay", "Ritu", "Deepak", "Shalini"],
    surname: &["Sharma", "Patel", "Reddy", "Gupta", "Singh", "Verma", "Chopra", "Mehta", "Joshi", "Bhat", "Kulkarni", "Nair"],
};
const FILIPINO: Pool = Pool {
    given: &["Maria", "Jose", "Juan", "Ana", "Miguel", "Rosa", "Antonio", "Liza", "Ramon", "Carmen", "Pedro", "Elena"],
    surname: &["Santos", "Reyes", "Cruz", "Bautista", "Ocampo", "Garcia", "Mendoza", "Torres", "Ramos", "Aquino", "Navarro", "De la Cruz"],
};

static SEQ: AtomicU64 = AtomicU64::new(0);

fn pick<'a>(items: &'a [&'a str]) -> &'a str {
    items.choose(&mut rand::thread_rng()).expect("non-empty name pool")
}

fn from_pool(pool: &Pool) -> String {
    format!("{} {}", pick(pool.given), pick(pool.surname))
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn singaporean_name() -> String {
    let pools = [&SG_CHINESE, &SG_MALAY, &SG_INDIAN];
    from_pool(pools.choose(&mut rand::thread_rng()).expect("SG pools"))
}

pub fn vendor_name() -> String {
    let pools = [&INDIAN, &FILIPINO];
    from_pool(pools.choose(&mut rand::thread_rng()).expect("vendor pools"))
}

pub fn name_for_affiliation(affiliation: &str, label: &str) -> String {
    match affiliation {
        "agency" => singaporean_name(),
        "vendor" => vendor_name(),
        _ => format!("{} {}", label, SEQ.fetch_add(1, Ordering::SeqCst) + 1),
    }
}
