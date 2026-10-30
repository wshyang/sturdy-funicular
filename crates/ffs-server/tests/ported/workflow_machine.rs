//! Port of test/backend/deno/workflow-machine.test.tsx (16 parity assertions).
use ffs_server::workflow_machine::{get_next_state, WorkflowEvent, WorkflowSnapshot};
use ffs_test_support::{parity_assert, parity_assert_eq};

fn snap(status: &str, ordinal: i16) -> WorkflowSnapshot { WorkflowSnapshot { status: status.into(), current_step_ordinal: ordinal } }
fn next(status: &str, ordinal: i16, event: WorkflowEvent) -> (String, i16) {
    let n = get_next_state(&snap(status, ordinal), &event).unwrap();
    (n.status, n.current_step_ordinal)
}

#[test]
fn workflow_machine_get_next_state() {
    parity_assert_eq!("L:f2a93653719e66df-1", next("returned_to_vendor", 5, WorkflowEvent::Submit { has_approval_steps: true }), ("submitted".into(), 2));
    parity_assert_eq!("L:50d0df3415a29f3e-1", next("returned_to_vendor", 5, WorkflowEvent::Submit { has_approval_steps: false }), ("under_review".into(), 0));
    parity_assert_eq!("L:37d7b0f8f5ae5560-1", next("submitted", 2, WorkflowEvent::StepApprove { has_next_step: true, next_ordinal: 3 }), ("under_review".into(), 3));
    parity_assert_eq!("L:aa8b7a03eb57f7dc-1", next("submitted", 2, WorkflowEvent::StepApprove { has_next_step: false, next_ordinal: 0 }), ("under_review".into(), 0));
    parity_assert_eq!("L:af5a3091a0f509d9-1", next("under_review", 3, WorkflowEvent::StepApprove { has_next_step: true, next_ordinal: 4 }), ("under_review".into(), 4));
    parity_assert_eq!("L:b2494c98ac8a5f39-1", next("under_review", 4, WorkflowEvent::StepApprove { has_next_step: false, next_ordinal: 0 }), ("under_review".into(), 0));
    parity_assert_eq!("L:4f2bc30aa9553397-1", next("under_review", 3, WorkflowEvent::StepReturn), ("returned_to_vendor".into(), 3));
    parity_assert_eq!("L:d0f095cc0da0b238-1", next("submitted", 2, WorkflowEvent::StepReject), ("rejected".into(), 2));
    parity_assert_eq!("L:b386ea0215b72899-1", next("under_review", 0, WorkflowEvent::OwnerApprove), ("approved".into(), 0));
    parity_assert_eq!("L:2b04cecfc666583a-1", next("under_review", 0, WorkflowEvent::OwnerReturn), ("returned_to_vendor".into(), 0));
    parity_assert_eq!("L:7b8a9166ab1685c3-1", next("under_review", 0, WorkflowEvent::OwnerReject), ("rejected".into(), 0));
    parity_assert_eq!("L:fea6ed198afcc832-1", next("approved", 0, WorkflowEvent::IssueCredential), ("credential_issued".into(), 0));
    parity_assert_eq!("L:afb94b221472b453-1", next("credential_issued", 0, WorkflowEvent::Close), ("closed".into(), 0));
    for status in ["submitted", "under_review", "returned_to_vendor", "rejected", "approved", "credential_issued"] {
        parity_assert_eq!("L:9ca2af4a489ca3ba-1", next(status, 3, WorkflowEvent::AdminReset { has_approval_steps: true }), ("returned_to_vendor".into(), 2));
    }
    parity_assert_eq!("L:172e98196e4bb44c-1", next("rejected", 3, WorkflowEvent::AdminReset { has_approval_steps: false }), ("returned_to_vendor".into(), 0));
    parity_assert!("L:ab2880d2d99f1a9e-1", get_next_state(&snap("bogus", 0), &WorkflowEvent::OwnerApprove).is_none());
}
