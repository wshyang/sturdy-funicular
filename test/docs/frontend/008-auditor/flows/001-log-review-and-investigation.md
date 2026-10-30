# Flow 001: Comprehensive Log Review and Investigation

## Persona
**008-auditor** - Henry Lim

## Flow Overview
Auditor reviews all system access and activities across the entire platform, investigating suspicious patterns and ensuring compliance.

## Preconditions
- User is logged in as Auditor (Henry Lim)
- User has audit affiliation
- User has read-only access to all logs
- User is on the Audit Dashboard

## Steps

### Step 1: Navigate to Audit Dashboard
- **Action:** Click on "Audit" in main navigation
- **Test ID:** `nav__audit-link`
- **Expected:** Audit Dashboard opens with overview

### Step 2: View Dashboard Overview
- **Action:** Check dashboard summary cards
- **Test IDs:**
  - `audit-dashboard__total-access-events`
  - `audit-dashboard__total-audit-events`
  - `audit-dashboard__total-sent-emails`
  - `audit-dashboard__active-users`
- **Expected:** Overview shows:
  - Total Access Events: 1,543
  - Total Audit Events: 892
  - Total Sent Emails: 456
  - Active Users: 23

### Step 3: Navigate to Access Log
- **Action:** Click on "Access Log" tab
- **Test ID:** `audit-dashboard__tab-access-log`
- **Expected:** Access Log page opens with full event list

### Step 4: Apply Date Range Filter
- **Action:** Set date range to "Last 7 Days"
- **Test ID:** `access-log__date-range-select`
- **Expected:** Logs filtered to last 7 days

### Step 5: Filter by Method
- **Action:** Select "POST" from method filter
- **Test ID:** `access-log__method-filter-post`
- **Expected:** Only POST requests are displayed

### Step 6: Filter by Status Code
- **Action:** Select "403" from status filter
- **Test ID:** `access-log__status-filter-403`
- **Expected:** Only 403 Forbidden responses are displayed

### Step 7: Identify Suspicious Activity
- **Action:** Scroll through filtered results
- **Test IDs:**
  - `access-log__table-row-0`
  - `access-log__table-row-1`
- **Expected:** Suspicious entries visible:
  - Multiple 403 errors from same IP
  - Unusual POST to sensitive endpoints

### Step 8: Click on Suspicious Entry
- **Action:** Click on entry with multiple failed attempts
- **Test ID:** `access-log__table-row-suspicious-ip`
- **Expected:** Entry detail panel opens showing:
  - Timestamp: 2026-07-30 14:23:45
  - Method: POST
  - Path: /api/admin/users
  - Status: 403
  - IP: 192.168.1.100
  - User: unknown (failed auth)
  - Duration: 12ms

### Step 9: View Full Entry Details
- **Action:** Click "Show Full Details"
- **Test ID:** `access-log-entry__show-full-details`
- **Expected:** Full details modal shows:
  - Request headers
  - Request body (if available)
  - Response headers
  - Response body (error message)
  - User agent

### Step 10: Add Investigation Note
- **Action:** Click "Add Investigation Note" button
- **Test ID:** `access-log-entry__add-investigation-note-button`
- **Expected:** Investigation note modal opens

### Step 11: Enter Investigation Notes
- **Action:** Type "Multiple failed admin access attempts from IP 192.168.1.100. Potential brute force attack. Recommended: Block IP and investigate source." in notes field
- **Test ID:** `modal__investigation-note-input`
- **Expected:** Note text accepted

### Step 12: Save Investigation Note
- **Action:** Click "Save Note" button
- **Test ID:** `modal__save-note-button`
- **Expected:**
  - Note saved and attached to entry
  - Visible in investigation section
  - Success notification appears
  - Audit log entry created (for the note itself)

### Step 13: Filter by IP Address
- **Action:** Enter "192.168.1.100" in IP filter
- **Test ID:** `access-log__ip-filter-input`
- **Expected:** All entries from that IP are displayed

### Step 14: Export Filtered Results
- **Action:** Click "Export" button
- **Test ID:** `access-log__export-button`
- **Expected:** Export modal opens with current filters pre-applied

### Step 15: Generate Export
- **Action:** Select CSV format and click "Export"
- **Test IDs:**
  - `modal__export-format-csv`
  - `modal__export-button`
- **Expected:**
  - Export generated with filtered results
  - Download starts automatically
  - Success notification appears

### Step 16: Navigate to Audit Log
- **Action:** Click on "Audit Log" tab
- **Test ID:** `audit-dashboard__tab-audit-log`
- **Expected:** Audit Log page opens

### Step 17: Filter by Action Type
- **Action:** Select "user_tombstone" from action filter
- **Test ID:** `audit-log__action-filter-user_tombstone`
- **Expected:** Only user tombstone actions are displayed

### Step 18: Filter by Actor
- **Action:** Select "Alice Chen" from actor filter
- **Test ID:** `audit-log__actor-filter-Alice Chen`
- **Expected:** Only actions by Alice Chen are displayed

### Step 19: Review User Activity Pattern
- **Action:** Scroll through Alice Chen's actions
- **Test ID:** `audit-log__table`
- **Expected:** Pattern visible:
  - Multiple user management actions
  - System configuration changes
  - All within normal business hours

### Step 20: Navigate to Sent Emails
- **Action:** Click on "Sent Emails" tab
- **Test ID:** `audit-dashboard__tab-sent-emails`
- **Expected:** Sent Emails page opens

### Step 21: Filter by Recipient
- **Action:** Enter "bob.smith@" in recipient filter
- **Test ID:** `sent-emails__recipient-filter-input`
- **Expected:** Only emails to Bob Smith are displayed

### Step 22: Verify Email Content
- **Action:** Click on email with subject "Break-Glass Request Approved"
- **Test ID:** `sent-emails__table-row-approved-request`
- **Expected:** Email detail modal shows:
  - Full email content
  - Recipients
  - Trigger key
  - Timestamp
  - Status

## Postconditions
- All logs and emails are accessible
- Suspicious activity can be identified
- Investigation notes can be added
- Results can be exported for further analysis
- All review actions are audited

## Test Assertions
- [ ] Auditor can access Audit Dashboard
- [ ] Dashboard overview is visible
- [ ] Access Log can be accessed
- [ ] Date range filters work
- [ ] Method filters work
- [ ] Status code filters work
- [ ] Suspicious entries can be identified
- [ ] Entry details can be viewed
- [ ] Full details are available
- [ ] Investigation notes can be added
- [ ] Notes are saved and visible
- [ ] IP filters work
- [ ] Results can be exported
- [ ] Export respects current filters
- [ ] Audit Log can be accessed
- [ ] Action type filters work
- [ ] Actor filters work
- [ ] User activity patterns can be reviewed
- [ ] Sent Emails can be accessed
- [ ] Recipient filters work
- [ ] Email content can be verified
- [ ] All actions create audit entries

## Error Cases
- **No Results:** Filter returns no results
  - **Expected:** Empty state message with clear filter indicators
- **Invalid Date Range:** Start date after end date
  - **Expected:** Validation error, cannot apply filter
- **Export Too Large:** Attempt to export more than limit
  - **Expected:** Warning message, truncation or pagination offered

## Performance Considerations
- Dashboard should load within 500ms
- Filtering should be immediate for small datasets
- Large dataset filtering should complete within 1 second
- Entry details should load within 300ms
- Export generation should complete within 3 seconds for large datasets
