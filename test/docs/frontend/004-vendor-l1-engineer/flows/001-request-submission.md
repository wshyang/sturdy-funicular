# Flow 001: Break-Glass Request Submission

## Persona
**004-vendor-l1-engineer** - David Ng

## Flow Overview
Vendor L1 Engineer submits a break-glass request for a vendor-managed system.

## Preconditions
- User is logged in as Vendor L1 Engineer (David Ng)
- User has vendor affiliation
- User is a member of Vendor team
- Vendor systems are mapped and visible to user
- User is on the Dashboard

## Steps

### Step 1: Navigate to Dashboard
- **Action:** User lands on Dashboard after login
- **Test ID:** `dashboard__container`
- **Expected:** Vendor Dashboard is displayed

### Step 2: Click New Request Button
- **Action:** Click "New Break-Glass Request" button
- **Test ID:** `vendor-dashboard__new-request-button`
- **Expected:** Request submission form opens

### Step 3: Select System
- **Action:** Click system dropdown
- **Test ID:** `request-submit__system-select`
- **Expected:** Dropdown shows systems user has access to

### Step 4: Choose a System
- **Action:** Select "Vendor-Web-01" from dropdown
- **Test ID:** `request-submit__system-option-Vendor-Web-01`
- **Expected:** System is selected, form updates

### Step 5: Enter SR Number
- **Action:** Type "SR-2026-00123" in SR Number field
- **Test ID:** `request-submit__sr-number-input`
- **Expected:** SR number is accepted

### Step 6: Select Justification
- **Action:** Click justification dropdown
- **Test ID:** `request-submit__justification-select`
- **Expected:** Justification options are displayed

### Step 7: Choose Justification
- **Action:** Select "Emergency maintenance" from dropdown
- **Test ID:** `request-submit__justification-option-Emergency maintenance`
- **Expected:** Justification is selected

### Step 8: Enter Detailed Reason
- **Action:** Type "Critical security patch required for CVE-2026-1234" in reason text area
- **Test ID:** `request-submit__reason-textarea`
- **Expected:** Reason text is accepted

### Step 9: Add Credential Items
- **Action:** Click "Add Credential" button
- **Test ID:** `request-submit__add-credential-button`
- **Expected:** New credential item row appears

### Step 10: Select Credential Type
- **Action:** In first credential row, select "SSH Private Key"
- **Test ID:** `request-submit__credential-type-select-0`
- **Expected:** Credential type dropdown shows options

### Step 11: Enter Credential Details
- **Action:** Fill in credential details:
  - Hostname: "web01.vendor.local"
  - Username: "admin"
  - Port: "22"
- **Test IDs:**
  - `request-submit__credential-hostname-input-0`
  - `request-submit__credential-username-input-0`
  - `request-submit__credential-port-input-0`
- **Expected:** Details are accepted

### Step 12: Add Another Credential
- **Action:** Click "Add Credential" again
- **Test ID:** `request-submit__add-credential-button`
- **Expected:** Second credential row appears

### Step 13: Fill Second Credential
- **Action:** Select "Database Password" and fill details
- **Test IDs:**
  - `request-submit__credential-type-select-1`
  - `request-submit__credential-hostname-input-1`
  - `request-submit__credential-username-input-1`
- **Expected:** Second credential is configured

### Step 14: Review Request
- **Action:** Scroll to review all entered information
- **Expected:** Form shows summary of:
  - System: Vendor-Web-01
  - SR Number: SR-2026-00123
  - Justification: Emergency maintenance
  - Reason: Critical security patch...
  - 2 credential items

### Step 15: Submit Request
- **Action:** Click "Submit Request" button
- **Test ID:** `request-submit__submit-button`
- **Expected:** 
  - Form validates all fields
  - Confirmation modal appears
  - Click Confirm to submit

### Step 16: Confirm Submission
- **Action:** Click Confirm in modal
- **Test ID:** `modal__confirm-button`
- **Expected:** 
  - Request is submitted successfully
  - Request number is displayed (e.g., REQ-00123)
  - Success notification appears
  - User is redirected to request detail view
  - Audit log entry created
  - Requester (David) receives confirmation

### Step 17: View Request Status
- **Action:** On request detail page, verify status is "pending"
- **Test ID:** `request-detail__status-badge`
- **Expected:** Status shows "Pending L1 Approval"

## Postconditions
- Break-glass request is submitted
- Request is in pending state awaiting L1 approval
- Requester can track progress
- All stakeholders are notified (if configured)

## Test Assertions
- [ ] Vendor L1 can access request submission form
- [ ] Vendor L1 can select from available systems
- [ ] Vendor L1 can enter SR number
- [ ] Vendor L1 can select justification
- [ ] Vendor L1 can enter detailed reason
- [ ] Vendor L1 can add multiple credential items
- [ ] Vendor L1 can submit request
- [ ] Form validates all required fields
- [ ] Request is created with correct status
- [ ] Requester receives confirmation
- [ ] Cannot submit request for non-assigned systems

## Error Cases
- **Missing Required Fields:** Attempt to submit without SR number
  - **Expected:** Validation error, form not submitted
- **No Systems Available:** User has no systems mapped
  - **Expected:** Empty state message, cannot submit
- **Invalid Credential:** Attempt to add credential with invalid details
  - **Expected:** Validation error for that credential row

## Performance Considerations
- Form should load within 300ms
- System dropdown should populate within 200ms
- Submission should complete within 500ms
