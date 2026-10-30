# Flow 002: Request Approval for Owned Systems

## Persona
**006-system-owner** - Frank Wong

## Flow Overview
System Owner reviews and approves or rejects break-glass requests for systems they own. This is the primary approval authority for owned systems.

## Preconditions
- User is logged in as System Owner (Frank Wong)
- User owns system "Agency-DB-01"
- Request REQ-00123 is submitted for Agency-DB-01
- Request is in "Pending Owner Approval" status
- User is on the Requests Dashboard

## Steps

### Step 1: Navigate to Owner Approval Queue
- **Action:** Click on "Owner Approval" filter
- **Test ID:** `requests-dashboard__filter-owner-approval`
- **Expected:** Dashboard shows requests awaiting owner approval

### Step 2: Select Request for Review
- **Action:** Click on request "REQ-00123 - Database backup restoration"
- **Test ID:** `request-card-REQ-00123`
- **Expected:** Request detail page opens

### Step 3: Verify System Ownership
- **Action:** Check system information
- **Test IDs:**
  - `request-detail__system-name`
  - `request-detail__system-owner`
- **Expected:** Shows:
  - System: Agency-DB-01
  - Owner: Frank Wong (self)

### Step 4: Review Request Details
- **Action:** Scroll through request information
- **Test IDs:**
  - `request-detail__requester-name`
  - `request-detail__sr-number`
  - `request-detail__justification`
  - `request-detail__reason`
  - `request-detail__credentials-list`
- **Expected:** Full request visible:
  - Requester: Alice Chen (Super Admin)
  - SR Number: SR-2026-00123
  - Justification: Emergency maintenance
  - Reason: Database backup restoration after corruption
  - Credentials: Database admin access

### Step 5: Check Requester Authorization
- **Action:** Click "Check Authorization" button
- **Test ID:** `request-detail__check-authorization-button`
- **Expected:** Authorization check shows:
  - Requester: Alice Chen
  - Role: Super Administrator
  - Affiliation: Admin
  - Authorization: Valid (Super Admin can request any system)

### Step 6: Review Impact Assessment
- **Action:** Click "Impact Assessment" tab
- **Test ID:** `request-detail__tab-impact-assessment`
- **Expected:** Impact assessment panel shows:
  - System criticality: Critical
  - Dependencies: 5 downstream systems
  - Potential impact: High
  - Recommended approval: Yes (with caution)

### Step 7: Add Owner Comments
- **Action:** Type "Approved for emergency backup restoration. Requester is Super Admin with valid authorization." in owner comments
- **Test ID:** `request-detail__owner-comments-textarea`
- **Expected:** Comments are accepted

### Step 8: Set Conditions
- **Action:** Configure approval conditions:
  - Expiration: 24 hours
  - Require 2FA for Access: Yes
  - Notify on Access: Yes
- **Test IDs:**
  - `request-detail__expiration-select`
  - `request-detail__require-2fa-toggle`
  - `request-detail__notify-on-access-toggle`
- **Expected:** Conditions configured

### Step 9: Approve Request
- **Action:** Click "Approve" button
- **Test ID:** `request-detail__approve-button`
- **Expected:** Confirmation modal appears with:
  - Request: REQ-00123
  - System: Agency-DB-01
  - Expiration: 24 hours
  - Conditions: [summarized]

### Step 10: Confirm Approval
- **Action:** Click "Confirm Approval" in modal
- **Test ID:** `modal__confirm-approval-button`
- **Expected:**
  - Request status updates to "Approved"
  - Credentials are issued to requester
  - Owner approval recorded in audit trail
  - Success notification appears
  - Requester receives notification

### Step 11: Verify Approval
- **Action:** Refresh page
- **Test ID:** `request-detail__status-badge`
- **Expected:** Status shows "Approved" with green background

### Step 12: Reject Alternative Path - Open Different Request
- **Action:** Navigate to request REQ-00124
- **Test ID:** `request-card-REQ-00124`
- **Expected:** Different request detail page opens

### Step 13: Review Problematic Request
- **Action:** Review request details
- **Test IDs:**
  - `request-detail__system-name`
  - `request-detail__requester-name`
  - `request-detail__reason`
- **Expected:** Shows:
  - System: Agency-DB-01
  - Requester: Bob Smith (Agency L1)
  - Reason: "Need access for testing" (insufficient justification)

### Step 14: Add Rejection Comments
- **Action:** Type "Insufficient justification. Testing does not qualify for break-glass access. Please use standard access request process." in owner comments
- **Test ID:** `request-detail__owner-comments-textarea`
- **Expected:** Comments accepted

### Step 15: Reject Request
- **Action:** Click "Reject" button
- **Test ID:** `request-detail__reject-button`
- **Expected:** Confirmation modal appears

### Step 16: Confirm Rejection
- **Action:** Click "Confirm Rejection" in modal
- **Test ID:** `modal__confirm-rejection-button`
- **Expected:**
  - Request status updates to "Rejected"
  - Rejection recorded in audit trail
  - Success notification appears
  - Requester receives rejection notification

### Step 17: Verify Rejection
- **Action:** Check request status
- **Test ID:** `request-detail__status-badge`
- **Expected:** Status shows "Rejected" with red background

## Postconditions
- Requests for owned systems can be approved or rejected
- Owner approval is recorded
- Credentials are issued for approved requests
- Requesters are notified
- All actions are audited

## Test Assertions
- [ ] System Owner can view owner approval queue
- [ ] System ownership is verified
- [ ] Request details are visible
- [ ] Requester authorization can be checked
- [ ] Impact assessment is available
- [ ] Owner comments can be added
- [ ] Approval conditions can be set
- [ ] Requests can be approved
- [ ] Approval confirmation works
- [ ] Status updates correctly
- [ ] Credentials are issued
- [ ] Requester is notified
- [ ] Requests can be rejected
- [ ] Rejection comments can be added
- [ ] Rejection confirmation works
- [ ] Rejection status updates correctly
- [ ] Requester receives rejection notification
- [ ] All actions create audit entries

## Error Cases
- **Not Owner:** Request is for system not owned by user
  - **Expected:** Request not in owner approval queue, or 403 if accessed directly
- **Missing Comments:** Attempt to approve/reject without comments
  - **Expected:** Validation error, cannot submit
- **Invalid Expiration:** Set expiration to past date
  - **Expected:** Validation error, cannot approve

## Performance Considerations
- Request list should filter within 200ms
- Request details should load within 500ms
- Authorization check should complete within 300ms
- Approval/rejection should complete within 400ms
