//! Stage 4B: SSM role namespace, using the application discovery helper.
use ffs_server::aws::ssm::derive_role_base_name;
#[test]
fn role_namespace() {
    // parity-assert: L:bf1727cccadf7f78-1
    assert!(derive_role_base_name("arn:aws:iam::123456789012:role/ffs-test-foo") == "foo");
    // parity-assert: L:58bac85bd59610f2-1
    assert!(derive_role_base_name("arn:aws:iam::000000000000:role/ffs-e2e-assume-role") == "ffs-e2e-assume-role");
    // parity-assert: L:269d7fbf327d90f2-1
    assert!(derive_role_base_name("arn:aws:iam::123456789012:role/foo-test") == "foo-test");
}
