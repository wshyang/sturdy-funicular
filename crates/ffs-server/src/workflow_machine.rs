//! Pure request-lifecycle transition table (port of server/workflow-machine.tsx).
//! The persisted shape remains (status, current_step_ordinal); this module only
//! centralizes the next-state rules used by submit/step/owner/issue/close/reset.

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkflowSnapshot {
    pub status: String,
    pub current_step_ordinal: i16,
}

#[derive(Clone, Debug)]
pub enum WorkflowEvent {
    Submit { has_approval_steps: bool },
    StepApprove { has_next_step: bool, next_ordinal: i16 },
    StepReturn,
    StepReject,
    OwnerApprove,
    OwnerReturn,
    OwnerReject,
    IssueCredential,
    Close,
    AdminReset { has_approval_steps: bool },
}

fn snap(status: &str, ordinal: i16) -> WorkflowSnapshot {
    WorkflowSnapshot { status: status.to_string(), current_step_ordinal: ordinal }
}

/// Returns the next snapshot, or None when the event is not valid from the
/// current state (legacy getNextState throws on unrecognized status).
pub fn get_next_state(current: &WorkflowSnapshot, event: &WorkflowEvent) -> Option<WorkflowSnapshot> {
    let s = current.status.as_str();
    let ord = current.current_step_ordinal;
    match s {
        "submitted" | "under_review" if ord > 0 => match event {
            WorkflowEvent::StepApprove { has_next_step, next_ordinal } => {
                if *has_next_step { Some(snap("under_review", *next_ordinal)) } else { Some(snap("under_review", 0)) }
            }
            WorkflowEvent::StepReturn => Some(snap("returned_to_vendor", ord)),
            WorkflowEvent::StepReject => Some(snap("rejected", ord)),
            _ => None,
        },
        "under_review" if ord == 0 => match event {
            WorkflowEvent::OwnerApprove => Some(snap("approved", 0)),
            WorkflowEvent::OwnerReturn => Some(snap("returned_to_vendor", ord)),
            WorkflowEvent::OwnerReject => Some(snap("rejected", ord)),
            _ => None,
        },
        "returned_to_vendor" => match event {
            WorkflowEvent::Submit { has_approval_steps } => {
                if *has_approval_steps { Some(snap("submitted", 2)) } else { Some(snap("under_review", 0)) }
            }
            _ => None,
        },
        "approved" => match event {
            WorkflowEvent::IssueCredential => Some(snap("credential_issued", 0)),
            _ => None,
        },
        "credential_issued" => match event {
            WorkflowEvent::Close => Some(snap("closed", 0)),
            _ => None,
        },
        "rejected" | "closed" => None,
        _ => None,
    }.or_else(|| match event {
        // ADMIN_RESET bypasses the normal graph from any non-closed status.
        WorkflowEvent::AdminReset { has_approval_steps } if s != "closed" => {
            Some(snap("returned_to_vendor", if *has_approval_steps { 2 } else { 0 }))
        }
        _ => None,
    })
}
