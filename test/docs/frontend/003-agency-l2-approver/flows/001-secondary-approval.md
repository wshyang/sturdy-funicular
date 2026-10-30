# Flow 001: Secondary Approval for High-Risk Requests

## Persona
**003-agency-l2-approver** - Catherine Tan

## Flow Overview
Agency L2 Approver reviews and provides secondary approval for break-glass requests that have already received L1 approval. This is a critical compliance checkpoint for high-risk access.

## Preconditions
- User is logged in as Agency L2 Approver (Catherine Tan)
- User has agency affiliation
- User is on the Requests Dashboard
- There exists at least one request with "Pending L2 Approval" status
- L1 Team Lead has already approved the request

## Steps

### Step 1: Navigate to Pending L2 Requests
- **Action:** Click on "Pending L2" filter in Requests Dashboard
- **Test ID:** `requests-dashboard__filter-pending-l2`
- **Expected:** Dashboard filters to show only requests awaiting L2 approval

### Step 2: Select a Request for Review
- **Action:** Click on request card "REQ-00123 - Emergency patch for CVE-2026-1234"
- **Test ID:** `request-card-REQ-00123`
- **Expected:** Request detail page opens with full request information

### Step 3: Review Request Details
- **Action:** Scroll through request details
- **Test IDs:**
  - `request-detail__system-name`
  - `request-detail__requester-name`
  - `request-detail__sr-number`
  - `request-detail__justification`
  - `request-detail__reason`
  - `request-detail__credentials-list`
- **Expected:** All request information is visible including:
  - System: Agency-Web-01
  - Requester: Bob Smith (L1 Team Lead)
  - SR Number: SR-2026-00123
  - Justification: Emergency maintenance
  - Reason: Critical security patch for CVE-2026-1234
  - Credential items with details
  - L1 approval timestamp and approver

### Step 4: Verify L1 Approval
- **Action:** Check the approval history section
- **Test ID:** `request-detail__approval-history`
- **Expected:** Shows L1 approval entry with:
  - Approver: Bob Smith
  - Timestamp: Recent (within last 24 hours)
  - Status: Approved

### Step 5: Review Policy Compliance
- **Action:** Click "Policy Check" button
- **Test ID:** `request-detail__policy-check-button`
- **Expected:** Policy compliance modal opens showing:
  - All required justifications are present
  - SR number is valid format
  - Request falls within approved maintenance window (if applicable)
  - No conflicting active requests for same system

### Step 6: Check System Dependencies
- **Action:** Click "System Info" tab
- **Test ID:** `request-detail__tab-system-info`
- **Expected:** System information panel shows:
  - System owner: Frank Wong
  - System criticality: High
  - Dependencies: 3 downstream systems
  - Last maintenance: 30 days ago

### Step 7: Add L2 Approval Comments
- **Action:** Type "Verified CVE-2026-1234 is legitimate. L1 approval valid. Policy compliant." in L2 comments field
- **Test ID:** `request-detail__l2-comments-textarea`
- **Expected:** Comment text is accepted

### Step 8: Approve Request
- **Action:** Click "Approve L2" button
- **Test ID:** `request-detail__approve-l2-button`
- **Expected:** Confirmation modal appears with summary:
  - Request: REQ-00123
  - Action: L2 Approval
  - System: Agency-Web-01
  - Your comments: [displayed]

### Step 9: Confirm Approval
- **Action:** Click "Confirm Approval" in modal
- **Test ID:** `modal__confirm-approval-button`
- **Expected:**
  - Request status updates to "Approved"
  - L2 approval entry added to audit trail
  - Success notification appears
  - Requester (Bob Smith) receives notification (if configured)
  - System owner (Frank Wong) receives notification (if configured)
  - Credentials are issued to requester

### Step 10: Verify Approval
- **Action:** Refresh page and check request status
- **Test ID:** `request-detail__status-badge`
- **Expected:** Status badge shows "Approved" with green background

### Step 11: Check Audit Log
- **Action:** Navigate to Admin Panel > Audit Log
- **Test ID:** `admin-panel__tab-audit-log`
- **Expected:** New audit entry appears for L2 approval with:
  - Action: request_approved_l2
  - Target: REQ-00123
  - Actor: Catherine Tan
  - Details include approval comments

## Postconditions
- Request is fully approved and ready for credential issuance
- All stakeholders are notified
- Audit trail records the approval
- Requester can now access the credentials

## Test Assertions
- [ ] L2 Approver can view pending L2 requests
- [ ] L2 Approver can open request details
- [ ] All request information is visible
- [ ] L1 approval is visible and verified
- [ ] Policy compliance check is available
- [ ] System information is accessible
- [ ] L2 comments can be added
- [ ] L2 approval can be submitted
- [ ] Confirmation modal shows correct summary
- [ ] Request status updates correctly
- [ ] Audit log entry is created
- [ ] Notifications are sent to stakeholders
- [ ] Cannot approve without L1 approval first

## Error Cases
- **No L1 Approval:** Attempt to approve request without L1 approval
  - **Expected:** "L1 Approval Required" error message, approval button disabled
- **Policy Violation:** Policy check reveals compliance issue
  - **Expected:** Warning displayed, approval button disabled until resolved
- **Missing Comments:** Attempt to approve without adding L2 comments
  - **Expected:** Validation error, cannot submit
- **Unauthorized:** Non-L2 user attempts to approve
  - **Expected:** 403 Forbidden error

## Performance Considerations
- Request list should filter within 200ms
- Request detail page should load within 500ms
- Policy check should complete within 300ms
- Approval submission should complete within 400ms
