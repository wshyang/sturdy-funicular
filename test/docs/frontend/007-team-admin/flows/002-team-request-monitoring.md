# Flow 002: Team Request Activity Monitoring

## Persona
**007-team-admin** - Grace Tan

## Flow Overview
Team Administrator monitors and tracks all break-glass request activity for their team, ensuring compliance and identifying issues.

## Preconditions
- User is logged in as Team Administrator (Grace Tan)
- User administers team "Agency-Web-Team"
- Team has multiple active and completed requests
- User is on the Team Dashboard

## Steps

### Step 1: Navigate to Team Dashboard
- **Action:** Click on "Agency-Web-Team" from team list
- **Test ID:** `team-dashboard__team-select-Agency-Web-Team`
- **Expected:** Team dashboard opens with request overview

### Step 2: View Request Summary
- **Action:** Check request summary cards
- **Test IDs:**
  - `team-dashboard__summary-pending`
  - `team-dashboard__summary-approved`
  - `team-dashboard__summary-rejected`
  - `team-dashboard__summary-expired`
- **Expected:** Summary shows:
  - Pending: 3 requests
  - Approved: 12 requests
  - Rejected: 1 request
  - Expired: 2 requests

### Step 3: Filter by Status
- **Action:** Select "Pending" from status filter
- **Test ID:** `team-dashboard__status-filter-pending`
- **Expected:** Only pending requests are displayed

### Step 4: Sort by Date
- **Action:** Click "Date" sort header
- **Test ID:** `team-dashboard__sort-date`
- **Expected:** Requests sorted by date (newest first)

### Step 5: Open Request Details
- **Action:** Click on request "REQ-00301 - Web server configuration update"
- **Test ID:** `team-dashboard__request-row-REQ-00301`
- **Expected:** Request detail modal opens

### Step 6: Review Request for Compliance
- **Action:** Check all compliance indicators
- **Test IDs:**
  - `request-detail__compliance-status`
  - `request-detail__justification-valid`
  - `request-detail__sr-number-valid`
  - `request-detail__requester-authorized`
- **Expected:** All compliance checks pass:
  - Justification: Valid
  - SR Number: Valid format
  - Requester: Authorized
  - Overall: Compliant

### Step 7: Flag Non-Compliant Request
- **Action:** Navigate to request "REQ-00302"
- **Test ID:** `team-dashboard__request-row-REQ-00302`
- **Expected:** Non-compliant request opens

### Step 8: Identify Compliance Issue
- **Action:** Check compliance indicators
- **Test IDs:**
  - `request-detail__compliance-status`
  - `request-detail__justification-invalid`
- **Expected:** Shows:
  - Justification: Invalid (missing required details)
  - Overall: Non-Compliant

### Step 9: Add Compliance Note
- **Action:** Click "Add Compliance Note" button
- **Test ID:** `request-detail__add-compliance-note-button`
- **Expected:** Compliance note modal opens

### Step 10: Enter Note
- **Action:** Type "Missing detailed justification. Requester notified to provide more information." in note field
- **Test ID:** `modal__compliance-note-input`
- **Expected:** Note text accepted

### Step 11: Save Compliance Note
- **Action:** Click "Save Note" button
- **Test ID:** `modal__save-note-button`
- **Expected:**
  - Note saved
  - Visible in compliance section
  - Requester receives notification
  - Audit log entry created

### Step 12: Export Team Requests
- **Action:** Click "Export" button
- **Test ID:** `team-dashboard__export-button`
- **Expected:** Export modal opens with options:
  - Format: CSV, JSON, PDF
  - Date Range: Last 7 days, Last 30 days, Custom
  - Status: All, Pending, Approved, Rejected

### Step 13: Configure Export
- **Action:** Select:
  - Format: CSV
  - Date Range: Last 30 days
  - Status: All
- **Test IDs:**
  - `modal__export-format-select`
  - `modal__export-date-range-select`
  - `modal__export-status-select`
- **Expected:** Export configured

### Step 14: Generate Export
- **Action:** Click "Generate Export" button
- **Test ID:** `modal__generate-export-button`
- **Expected:**
  - Export generated
  - Download starts automatically
  - Success notification appears
  - Audit log entry created

### Step 15: Set Up Alerts
- **Action:** Click "Alerts" tab
- **Test ID:** `team-dashboard__tab-alerts`
- **Expected:** Alerts configuration panel opens

### Step 16: Configure Request Alerts
- **Action:** Enable alerts for:
  - New request submitted: Email
  - Request approved: Email + Slack
  - Request rejected: Email
  - Request expired: Email
- **Test IDs:**
  - `alerts__new-request-email-toggle`
  - `alerts__request-approved-email-toggle`
  - `alerts__request-approved-slack-toggle`
  - `alerts__request-rejected-email-toggle`
  - `alerts__request-expired-email-toggle`
- **Expected:** Alerts configured

### Step 17: Save Alert Configuration
- **Action:** Click "Save Alerts" button
- **Test ID:** `alerts__save-button`
- **Expected:**
  - Configuration saved
  - Success notification appears

### Step 18: View Team Audit Trail
- **Action:** Click "Audit Trail" tab
- **Test ID:** `team-dashboard__tab-audit-trail`
- **Expected:** Team-specific audit trail shows:
  - All team-related actions
  - Member additions/removals
  - Request submissions/approvals
  - Export generations
  - Filterable by date and action type

## Postconditions
- Team request activity is monitored
- Compliance issues can be identified and noted
- Requests can be exported for reporting
- Alerts are configured for important events
- Audit trail is available for team activities

## Test Assertions
- [ ] Team Admin can view team dashboard
- [ ] Request summary is visible
- [ ] Requests can be filtered by status
- [ ] Requests can be sorted
- [ ] Request details can be opened
- [ ] Compliance status is visible
- [ ] Compliance issues can be identified
- [ ] Compliance notes can be added
- [ ] Notes are saved and visible
- [ ] Requester receives notification for compliance notes
- [ ] Requests can be exported
- [ ] Export options can be configured
- [ ] Export can be generated and downloaded
- [ ] Alerts can be configured
- [ ] Alert configuration is saved
- [ ] Team audit trail is visible
- [ ] Audit trail can be filtered
- [ ] All actions create audit entries

## Error Cases
- **No Requests:** Team has no requests in selected filter
  - **Expected:** Empty state message
- **Export Failure:** Export generation fails
  - **Expected:** Error message, retry option
- **Invalid Alert Config:** Attempt to configure invalid alert
  - **Expected:** Validation error

## Performance Considerations
- Dashboard should load within 400ms
- Filtering and sorting should be immediate
- Request details should load within 300ms
- Export generation should complete within 2 seconds
- Audit trail should load within 500ms
