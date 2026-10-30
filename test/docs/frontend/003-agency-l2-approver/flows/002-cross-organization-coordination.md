# Flow 002: Cross-Organization Coordination with Vendor L2

## Persona
**003-agency-l2-approver** - Catherine Tan

## Flow Overview
Agency L2 Approver coordinates with Vendor L2 Specialist for joint approval of cross-organization break-glass requests. This ensures both agency and vendor perspectives are considered.

## Preconditions
- User is logged in as Agency L2 Approver (Catherine Tan)
- Vendor L2 Specialist (Evelyn Koh) is available
- There exists a cross-organization request requiring both approvals
- Request is in "Pending Cross-Org L2" status

## Steps

### Step 1: Identify Cross-Organization Request
- **Action:** Filter requests by "Cross-Org" tag
- **Test ID:** `requests-dashboard__filter-cross-org`
- **Expected:** Shows requests requiring coordination between agency and vendor

### Step 2: Open Cross-Org Request
- **Action:** Click on request "REQ-00156 - Vendor system access for incident response"
- **Test ID:** `request-card-REQ-00156`
- **Expected:** Request detail page shows cross-organization indicators

### Step 3: Review Agency-Side Requirements
- **Action:** Check agency-specific details
- **Test IDs:**
  - `request-detail__agency-requirements`
  - `request-detail__agency-justification`
- **Expected:** Agency requirements are displayed:
  - Incident response coordination needed
  - Access to vendor-managed system required
  - Joint approval mandatory

### Step 4: View Vendor L1 Approval
- **Action:** Scroll to vendor approval section
- **Test ID:** `request-detail__vendor-l1-approval`
- **Expected:** Shows Vendor L1 Engineer (David Ng) has approved with timestamp

### Step 5: Add Agency L2 Comments
- **Action:** Type "Agency confirms incident requires vendor system access. Coordinating with Vendor L2." in agency L2 comments
- **Test ID:** `request-detail__agency-l2-comments-textarea`
- **Expected:** Comments are saved as draft

### Step 6: Initiate Vendor L2 Coordination
- **Action:** Click "Request Vendor L2 Review" button
- **Test ID:** `request-detail__request-vendor-l2-button`
- **Expected:** 
  - Vendor L2 Specialist (Evelyn Koh) receives notification
  - Request status updates to "Vendor L2 Review Pending"
  - Coordination thread is created

### Step 7: Wait for Vendor L2 Input
- **Action:** Refresh page after Vendor L2 has responded
- **Expected:** Vendor L2 comments appear in coordination section

### Step 8: Review Vendor L2 Feedback
- **Action:** Read Vendor L2 comments
- **Test ID:** `request-detail__vendor-l2-comments`
- **Expected:** Evelyn Koh's comments visible:
  - "Vendor confirms system is available for break-glass access"
  - "Credentials prepared and ready for issuance"
  - "No conflicts with vendor operations"

### Step 9: Add Final Agency L2 Approval
- **Action:** Type "Vendor L2 approval confirmed. Agency L2 approving for joint access." in final comments
- **Test ID:** `request-detail__final-l2-comments-textarea`
- **Expected:** Final comments field accepts input

### Step 10: Submit Joint Approval
- **Action:** Click "Submit Joint Approval" button
- **Test ID:** `request-detail__submit-joint-approval-button`
- **Expected:** Confirmation modal appears showing:
  - Agency L2: Catherine Tan
  - Vendor L2: Evelyn Koh
  - Joint approval summary

### Step 11: Confirm Joint Approval
- **Action:** Click "Confirm Joint Approval" in modal
- **Test ID:** `modal__confirm-joint-approval-button`
- **Expected:**
  - Request status updates to "Joint Approved"
  - Both L2 approvals recorded in audit trail
  - All stakeholders notified
  - Credentials issued to original requester

### Step 12: Verify in Audit Log
- **Action:** Navigate to Audit Log and filter by request ID
- **Test ID:** `admin-audit-log__filter-request-id`
- **Expected:** Shows two approval entries:
  - Agency L2 approval by Catherine Tan
  - Vendor L2 approval by Evelyn Koh (if already recorded)

## Postconditions
- Cross-organization request is fully approved
- Both agency and vendor L2 approvals are recorded
- Coordination is complete
- Credentials are available to requester

## Test Assertions
- [ ] Agency L2 can identify cross-org requests
- [ ] Cross-org indicators are visible
- [ ] Vendor L1 approval is visible
- [ ] Agency L2 can add comments
- [ ] Vendor L2 coordination can be initiated
- [ ] Vendor L2 feedback is visible
- [ ] Joint approval can be submitted
- [ ] Both approvals are recorded
- [ ] Request status updates correctly
- [ ] All stakeholders are notified
- [ ] Audit trail captures both approvals

## Error Cases
- **Vendor L2 Unavailable:** Vendor L2 has not responded
  - **Expected:** "Awaiting Vendor L2 Response" message, cannot submit joint approval
- **Conflicting Approvals:** Vendor L2 rejects while agency approves
  - **Expected:** Status updates to "Conflict Resolution Needed", escalation path shown
- **Missing Agency Comments:** Attempt to submit without agency L2 comments
  - **Expected:** Validation error, cannot submit

## Performance Considerations
- Coordination notifications should be delivered within 500ms
- Status updates should reflect within 1 second across all users
- Audit log entries should appear within 200ms
