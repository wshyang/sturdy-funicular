//! Port of test/backend/deno/name_seeds.test.tsx — fixture name pools.
use ffs_test_support::{name_seeds::*, parity_assert, parity_assert_eq};
use std::collections::HashSet;

const SG_GIVEN: &[&str] = &[
    "Wei", "Jia", "Yu", "Kai", "Hui", "Zhi", "Xin", "Jun", "Mei", "Si", "Yong", "Pei",
    "Muhammad", "Nurul", "Aisyah", "Farhan", "Siti", "Amir", "Hafiz", "Nadia", "Syafiq", "Aminah", "Rizwan", "Aqilah",
    "Arun", "Priya", "Rajesh", "Divya", "Karthik", "Meena", "Suresh", "Lakshmi", "Vijay", "Anjali", "Ravi", "Sangeetha",
];
const VENDOR_GIVEN: &[&str] = &[
    "Amit", "Neha", "Rahul", "Pooja", "Sandeep", "Anita", "Vikram", "Kavita", "Sanjay", "Ritu", "Deepak", "Shalini",
    "Maria", "Jose", "Juan", "Ana", "Miguel", "Rosa", "Antonio", "Liza", "Ramon", "Carmen", "Pedro", "Elena",
];

#[test]
fn singaporean_name_is_plausible_two_token_full_name() {
    let name = singaporean_name();
    parity_assert!("L:1874c299d3f28c30-1", !name.is_empty());
    parity_assert_eq!("L:ae51bb9ea9e6417d-1", name.split(' ').count() >= 2, true);
}

#[test]
fn vendor_name_is_indian_or_filipino_full_name() {
    let name = vendor_name();
    parity_assert!("L:a51f8812658ec341-1", !name.is_empty());
    parity_assert_eq!("L:e53740982ff340c0-1", name.split(' ').count() >= 2, true);
}

#[test]
fn singaporean_names_come_from_three_sg_ethnic_pools() {
    for _ in 0..200 {
        let name = singaporean_name();
        let given = name.split(' ').next().unwrap_or_default();
        parity_assert_eq!("L:f4ebdb2d8959846d-1", SG_GIVEN.contains(&given), true);
    }
}

#[test]
fn vendor_names_come_from_indian_filipino_pools() {
    for _ in 0..200 {
        let name = vendor_name();
        let given = name.split(' ').next().unwrap_or_default();
        parity_assert_eq!("L:1f13c7ce15473b8a-1", VENDOR_GIVEN.contains(&given), true);
    }
}

#[test]
fn name_for_affiliation_routes_agency_and_vendor() {
    let agency = name_for_affiliation("agency", "User");
    let vendor = name_for_affiliation("vendor", "User");
    parity_assert_eq!("L:9948b3ab3f6c2562-1", SG_GIVEN.contains(&agency.split(' ').next().unwrap_or_default()), true);
    parity_assert_eq!("L:d99e50acaec3390f-1", VENDOR_GIVEN.contains(&vendor.split(' ').next().unwrap_or_default()), true);
}

#[test]
fn names_vary_across_calls() {
    let mut seen = HashSet::new();
    for _ in 0..50 {
        seen.insert(singaporean_name());
    }
    parity_assert!("L:be05e30d9f4c537b-1", seen.len() != 1);
}
