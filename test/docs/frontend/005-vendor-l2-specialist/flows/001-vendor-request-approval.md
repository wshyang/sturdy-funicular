# Flow 001: Vendor L1 Request Approval

## Persona
**005-vendor-l2-specialist** - Evelyn Koh

## Flow Overview
Vendor L2 Specialist reviews and approves break-glass requests submitted by Vendor L1 Engineers. This is the primary approval workflow for vendor-managed systems.

## Preconditions
- User is logged in as Vendor L2 Specialist (Evelyn Koh)
- User has vendor affiliation
- User is on the Vendor Dashboard
- There exists at least one request with "Pending Vendor L2" status
- Vendor L1 Engineer (David Ng) has submitted the request

## Steps

### Step 1: Navigate to Vendor Dashboard
- **Action:** User lands on Vendor Dashboard after login
- **Test ID:** `vendor-dashboard__container`
- **Expected:** Vendor Dashboard is displayed with request list

### Step 2: Filter for Pending L2 Requests
- **Action:** Select "Pending L2" from status filter dropdown
- **Test ID:** `vendor-dashboard__status-filter-pending-l2`
- **Expected:** Dashboard shows only requests awaiting Vendor L2 approval

### Step 3: Select Request for Review
- **Action:** Click on request "REQ-00201 - Database migration support"
- **Test ID:** `request-card-REQ-00201`
- **Expected:** Request detail page opens

### Step 4: Review Request Details
- **Action:** Scroll through all request information
- **Test IDs:**
  - `request-detail__system-name`
  - `request-detail__requester-name`
  - `request-detail__sr-number`
  - `request-detail__justification`
  - `request-detail__reason`
  - `request-detail__credentials-list`
- **Expected:** Full request information visible:
  - System: Vendor-DB-03
  - Requester: David Ng (Vendor L1 Engineer)
  - SR Number: SR-2026-VENDOR-00201
  - Justification: Maintenance
  - Reason: Schema migration for new feature deployment
  - 2 credential items (database credentials, SSH access)

### Step 5: Verify System Ownership
- **Action:** Check system ownership section
- **Test ID:** `request-detail__system-ownership`
- **Expected:** Shows:
  - System owner: Evelyn Koh (self)
  - Vendor team: Vendor-Infrastructure
  - Criticality: Medium

### Step 6: Check Requester Authorization
- **Action:** Click "Verify Requester" button
- **Test ID:** `request-detail__verify-requester-button`
- **Expected:** Verification modal shows:
  - Requester: David Ng
  - Role: Vendor L1 Engineer
  - Team: Vendor-Infrastructure
  - Systems: [Vendor-DB-03, Vendor-Web-01, Vendor-Web-02]
  - Status: Active
  - **Result:** Requester is authorized for this system

### Step 7: Review Credential Requirements
- **Action:** Expand each credential item
- **Test IDs:**
  - `request-detail__credential-item-0`
  - `request-detail__credential-item-1`
- **Expected:** Credential details show:
  - Item 0: Database Password - Host: db03.vendor.local, User: admin
  - Item 1: SSH Private Key - Host: db03.vendor.local, User: deploy

### Step 8: Check for Conflicts
- **Action:** Click "Check Conflicts" button
- **Test ID:** `request-detail__check-conflicts-button`
- **Expected:** Conflict check results show:
  - No active requests for same system
  - No maintenance windows overlapping
  - No credential conflicts

### Step 9: Add Approval Comments
- **Action:** Type "Request verified. Schema migration approved. Credentials valid for deployment window." in approval comments
- **Test ID:** `request-detail__approval-comments-textarea`
- **Expected:** Comments are accepted

### Step 10: Set Expiration
- **Action:** Select "24 hours" from expiration dropdown
- **Test ID:** `request-detail__expiration-select`
- **Expected:** Expiration is set to 24 hours from now

### Step 11: Approve Request
- **Action:** Click "Approve" button
- **Test ID:** `request-detail__approve-button`
- **Expected:** Confirmation modal appears with:
  - Request: REQ-00201
  - System: Vendor-DB-03
  - Expiration: 24 hours
  - Comments: [displayed]

### Step 12: Confirm Approval
- **Action:** Click "Confirm Approval" in modal
- **Test ID:** `modal__confirm-approval-button`
- **Expected:**
  - Request status updates to "Approved"
  - Credentials are issued to requester (David Ng)
  - Approval recorded in audit trail
  - Success notification appears
  - Requester receives notification

### Step 13: Verify Credential Issuance
- **Action:** Navigate to Sent Emails in Admin Panel
- **Test ID:** `admin-panel__tab-sent-emails`
- **Expected:** Email notification visible for credential issuance to David Ng

## Postconditions
- Vendor L1 request is approved
- Credentials are issued to requester
- Audit trail records the approval
- Requester can access the credentials

## Test Assertions
- [ ] Vendor L2 can view pending L2 requests
- [ ] Vendor L2 can open request details
- [ ] System ownership is visible and correct
- [ ] Requester authorization can be verified
- [ ] Credential requirements are visible
- [ ] Conflict check is available and works
- [ ] Approval comments can be added
- [ ] Expiration can be set
- [ ] Approval can be submitted
- [ ] Confirmation modal shows correct summary
- [ ] Request status updates correctly
- [ ] Credentials are issued to requester
- [ ] Audit trail entry is created
- [ ] Requester receives notification
- [ ] Cannot approve requests for non-owned systems

## Error Cases
- **Unauthorized System:** Request is for system not owned by this Vendor L2
  - **Expected:** "System Not Authorized" error, approval button disabled
- **Unauthorized Requester:** Requester is not authorized for this system
  - **Expected:** "Requester Not Authorized" warning, approval button disabled
- **Conflict Detected:** Conflict check reveals issues
  - **Expected:** Conflicts listed, approval button disabled until resolved
- **Missing Comments:** Attempt to approve without comments
  - **Expected:** Validation error, cannot submit

## Performance Considerations
- Request list should filter within 200ms
- Request detail page should load within 500ms
- Conflict check should complete within 300ms
- Approval submission should complete within 400ms
- Credential issuance should complete within 500ms
