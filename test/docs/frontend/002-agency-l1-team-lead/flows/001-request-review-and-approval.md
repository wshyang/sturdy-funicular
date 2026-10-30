# Flow 001: Request Review and Approval

## Persona
**002-agency-l1-team-lead** - Benjamin Lee

## Flow Overview
Agency L1 Team Lead reviews and approves break-glass requests for assigned systems.

## Preconditions
- User is logged in as Agency L1 Team Lead (Benjamin Lee)
- User is a member of Agency team
- User has team_admin role for Agency team
- There are pending requests for systems assigned to Agency team
- User is on the Dashboard

## Steps

### Step 1: Navigate to Dashboard
- **Action:** User lands on Dashboard after login
- **Test ID:** `dashboard__container`
- **Expected:** Dashboard displays with appropriate view based on affiliation

### Step 2: View Pending Requests
- **Action:** Scroll to "Pending My Approval" section
- **Test ID:** `dashboard__pending-approval-section`
- **Expected:** List of requests awaiting L1 approval is displayed

### Step 3: Select a Request
- **Action:** Click on first pending request
- **Test ID:** `dashboard__request-row-pending` (first row)
- **Expected:** Request detail view opens

### Step 4: Review Request Details
- **Action:** Review request information (SR number, justification, system, requester)
- **Test IDs:**
  - `request-detail__sr-number`
  - `request-detail__justification`
  - `request-detail__system`
  - `request-detail__requester`
- **Expected:** All request details are displayed

### Step 5: Review Requested Credentials
- **Action:** Scroll to "Requested Credentials" section
- **Test ID:** `request-detail__credentials-section`
- **Expected:** List of requested credentials is displayed

### Step 6: Check Requester Authorization
- **Action:** Verify requester is authorized for this system
- **Expected:** System shows requester's relationship to the system

### Step 7: Approve Request
- **Action:** Click "Approve" button
- **Test ID:** `request-detail__approve-button`
- **Expected:** 
  - Approval modal opens
  - Can add approval notes
  - Click Confirm to approve

### Step 8: Confirm Approval
- **Action:** Click Confirm in approval modal
- **Test ID:** `modal__confirm-button`
- **Expected:** 
  - Request status changes to "approved"
  - Request moves to next approval step (L2)
  - Success notification appears
  - Audit log entry created
  - Requester receives notification (if configured)

### Step 9: View Next Pending Request
- **Action:** Return to dashboard, view next pending request
- **Expected:** Next request is displayed for review

### Step 10: Reject a Request
- **Action:** For a different request, click "Reject" button
- **Test ID:** `request-detail__reject-button`
- **Expected:** Rejection modal opens

### Step 11: Provide Rejection Reason
- **Action:** Select reason "Insufficient justification" and add notes
- **Test IDs:**
  - `modal__reason-select`
  - `modal__notes-input`
- **Expected:** Modal accepts input

### Step 12: Confirm Rejection
- **Action:** Click Confirm to reject
- **Test ID:** `modal__confirm-button`
- **Expected:** 
  - Request status changes to "rejected"
  - Requester receives notification
  - Audit log entry created

## Postconditions
- L1 Team Lead can review and approve/reject requests
- Approved requests move to next step
- Rejected requests return to requester
- All actions are audited

## Test Assertions
- [ ] L1 Team Lead can view pending requests
- [ ] L1 Team Lead can view request details
- [ ] L1 Team Lead can approve requests
- [ ] L1 Team Lead can reject requests
- [ ] Approved requests move to next step
- [ ] Rejected requests are returned to requester
- [ ] All actions create audit log entries
- [ ] Cannot approve requests for non-assigned systems

## Error Cases
- **No Pending Requests:** No requests awaiting L1 approval
  - **Expected:** Empty state message displayed
- **Already Approved:** Attempt to approve already-approved request
  - **Expected:** Error message, action not allowed
- **Unauthorized System:** Attempt to approve request for non-assigned system
  - **Expected:** 403 Forbidden error

## Performance Considerations
- Dashboard should load within 500ms
- Request detail should load within 300ms
- Approval/rejection should complete within 500ms
