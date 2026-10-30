# Flow 003: Audit Log Review and Investigation

## Persona
**001-super-admin** - Alice Chen

## Flow Overview
Super Administrator reviews audit logs, access logs, and investigates suspicious activities.

## Preconditions
- User is logged in as Super Administrator (Alice Chen)
- User has `full_admin` role
- There are audit log entries in the system
- User is on the Admin Panel

## Steps

### Step 1: Navigate to Audit Log Tab
- **Action:** Click on "Audit Log" tab in Admin Panel
- **Test ID:** `admin-panel__tab-audit`
- **Expected:** Audit Log tab opens

### Step 2: View Recent Audit Entries
- **Action:** Scroll through audit log entries
- **Test ID:** `admin-audit-log__table`
- **Expected:** Recent audit entries are displayed in reverse chronological order

### Step 3: Filter by Date Range
- **Action:** Set date range filter to "Last 7 Days"
- **Test ID:** `admin-audit-log__filter-date-range`
- **Expected:** Only entries from the last 7 days are displayed

### Step 4: Filter by Actor
- **Action:** Type "Alice" in actor filter
- **Test ID:** `admin-audit-log__filter-actor`
- **Expected:** Only entries where Alice is the actor are displayed

### Step 5: Filter by Action Type
- **Action:** Select "request.submitted" from action type filter
- **Test ID:** `admin-audit-log__filter-action-type`
- **Expected:** Only request submission entries are displayed

### Step 6: View Entry Details
- **Action:** Click on a specific audit entry
- **Test ID:** `admin-audit-log__row` (first matching row)
- **Expected:** Entry detail modal opens with full information

### Step 7: Review Entry Information
- **Action:** Review details (timestamp, actor, action, target, old/new values)
- **Test IDs:**
  - `admin-audit-log-detail__timestamp`
  - `admin-audit-log-detail__actor`
  - `admin-audit-log-detail__action`
  - `admin-audit-log-detail__target`
  - `admin-audit-log-detail__old-values`
  - `admin-audit-log-detail__new-values`
- **Expected:** All entry details are displayed

### Step 8: Navigate to Access Log Tab
- **Action:** Click on "Access Log" tab
- **Test ID:** `admin-panel__tab-access-log`
- **Expected:** Access Log tab opens

### Step 9: View Access Log Entries
- **Action:** Scroll through access log entries
- **Test ID:** `admin-access-log__table`
- **Expected:** Recent HTTP access entries are displayed

### Step 10: Filter Access Log
- **Action:** Filter by path containing "/requests/"
- **Test ID:** `admin-access-log__filter-path`
- **Expected:** Only access log entries for requests paths are displayed

### Step 11: Identify Suspicious Activity
- **Action:** Look for multiple failed login attempts
- **Expected:** Can identify patterns of suspicious activity

### Step 12: Export Log Data
- **Action:** Click Export button
- **Test ID:** `admin-audit-log__export-button`
- **Expected:** 
  - Export modal opens
  - Can select date range and format
  - Export completes successfully

## Postconditions
- Super Admin has reviewed audit and access logs
- Suspicious activities can be identified
- Log data can be exported for further analysis

## Test Assertions
- [ ] Super Admin can access Audit Log tab
- [ ] Super Admin can access Access Log tab
- [ ] Audit entries are displayed in reverse chronological order
- [ ] Access log entries are displayed in reverse chronological order
- [ ] Filters work correctly (date, actor, action type, path)
- [ ] Entry details can be viewed
- [ ] Log data can be exported
- [ ] Large log sets are handled efficiently

## Error Cases
- **No Entries:** No audit log entries exist
  - **Expected:** Empty state message displayed
- **Invalid Filter:** Invalid date range or filter value
  - **Expected:** Validation error, filter not applied
- **Export Failure:** Export fails due to system error
  - **Expected:** Error notification, system remains stable

## Performance Considerations
- Audit log should load within 500ms for first 100 entries
- Access log should load within 500ms for first 100 entries
- Filters should apply within 300ms
- Export should complete within 2 seconds for reasonable date ranges
