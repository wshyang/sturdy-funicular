# Flow 002: Compliance Reporting and Anomaly Detection

## Persona
**008-auditor** - Henry Lim

## Flow Overview
Auditor generates compliance reports, detects anomalies, and creates investigation summaries for security audits.

## Preconditions
- User is logged in as Auditor (Henry Lim)
- User has completed log review activities
- Multiple investigation notes exist
- User is on the Audit Dashboard

## Steps

### Step 1: Navigate to Reports
- **Action:** Click on "Reports" in main navigation
- **Test ID:** `nav__reports-link`
- **Expected:** Reports Dashboard opens

### Step 2: Create New Report
- **Action:** Click "Create Report" button
- **Test ID:** `reports-dashboard__create-report-button`
- **Expected:** Create report modal opens

### Step 3: Configure Report Parameters
- **Action:** Fill in report details:
  - Title: "Q3 2026 Security Audit"
  - Type: Compliance
  - Period: Last 90 Days
  - Scope: All Users, All Systems
- **Test IDs:**
  - `modal__report-title-input`
  - `modal__report-type-select`
  - `modal__report-period-select`
  - `modal__report-scope-select`
- **Expected:** Report parameters configured

### Step 4: Select Report Sections
- **Action:** Check sections to include:
  - [x] Access Log Summary
  - [x] Audit Trail Analysis
  - [x] Sent Email Review
  - [x] Anomaly Detection
  - [x] Compliance Checklist
- **Test IDs:**
  - `modal__report-section-access-log`
  - `modal__report-section-audit-trail`
  - `modal__report-section-sent-emails`
  - `modal__report-section-anomaly-detection`
  - `modal__report-section-compliance-checklist`
- **Expected:** Sections selected

### Step 5: Generate Report
- **Action:** Click "Generate Report" button
- **Test ID:** `modal__generate-report-button`
- **Expected:**
  - Report generation starts
  - Progress indicator shows
  - Report is generated in background

### Step 6: Monitor Generation Status
- **Action:** Check notifications
- **Test ID:** `notifications__container`
- **Expected:** Notification appears: "Report 'Q3 2026 Security Audit' is being generated..."

### Step 7: View Generated Report
- **Action:** After completion, click on report in reports list
- **Test ID:** `reports-dashboard__report-row-Q3 2026 Security Audit`
- **Expected:** Report detail page opens showing:
  - Report metadata (title, type, period, generated at)
  - Executive summary
  - Section navigation

### Step 8: Review Access Log Summary
- **Action:** Click on "Access Log Summary" section
- **Test ID:** `report__section-access-log-summary`
- **Expected:** Summary shows:
  - Total access events: 1,543
  - By method: GET (60%), POST (25%), DELETE (5%), other (10%)
  - By status: 200 (85%), 403 (8%), 404 (5%), 500 (2%)
  - Top IPs: 10.0.0.1 (35%), 10.0.0.2 (25%), etc.
  - Top users: Alice Chen (20%), Bob Smith (15%), etc.

### Step 9: Review Audit Trail Analysis
- **Action:** Click on "Audit Trail Analysis" section
- **Test ID:** `report__section-audit-trail-analysis`
- **Expected:** Analysis shows:
  - Total audit events: 892
  - By action type: user_create (10%), request_submit (25%), request_approve (20%), etc.
  - By actor: Alice Chen (40%), Bob Smith (20%), system (15%), etc.
  - Top targets: users (30%), requests (25%), systems (20%), etc.

### Step 10: Review Anomaly Detection
- **Action:** Click on "Anomaly Detection" section
- **Test ID:** `report__section-anomaly-detection`
- **Expected:** Anomalies detected:
  - Multiple failed login attempts from IP 192.168.1.100
  - Unusual access pattern from user Bob Smith (access at 3 AM)
  - High volume of requests from IP 10.0.0.50
  - Sequential request numbers (possible enumeration)

### Step 11: Review Compliance Checklist
- **Action:** Click on "Compliance Checklist" section
- **Test ID:** `report__section-compliance-checklist`
- **Expected:** Checklist shows:
  - [x] All access events logged
  - [x] All audit events logged
  - [x] All sensitive actions require 2FA
  - [x] All emails logged in sent_notifications
  - [ ] No unauthorized access attempts (FAILED - 12 attempts detected)
  - [x] All requests have valid justification
  - [x] All approvals follow proper workflow

### Step 12: Add Report Notes
- **Action:** Click "Add Note" button
- **Test ID:** `report__add-note-button`
- **Expected:** Note modal opens

### Step 13: Enter Report Notes
- **Action:** Type "Q3 audit reveals 12 unauthorized access attempts from IP 192.168.1.100. Recommendations: 1) Implement IP blocking, 2) Review authentication flow, 3) Enhance monitoring." in notes
- **Test ID:** `modal__report-note-input`
- **Expected:** Notes accepted

### Step 14: Save Report Notes
- **Action:** Click "Save" button
- **Test ID:** `modal__save-button`
- **Expected:** Notes saved and visible in report

### Step 15: Export Report
- **Action:** Click "Export" button
- **Test ID:** `report__export-button`
- **Expected:** Export modal opens with options:
  - Format: PDF (recommended), Word, HTML
  - Include: Summary only, Full report, Appendices

### Step 16: Generate PDF Export
- **Action:** Select PDF format and Full report, click "Export"
- **Test IDs:**
  - `modal__export-format-pdf`
  - `modal__export-include-full`
  - `modal__export-button`
- **Expected:**
  - PDF report generated
  - Download starts automatically
  - Success notification appears

### Step 17: Schedule Recurring Report
- **Action:** Click "Schedule Report" button
- **Test ID:** `reports-dashboard__schedule-report-button`
- **Expected:** Schedule modal opens

### Step 18: Configure Schedule
- **Action:** Set schedule:
  - Report Type: Compliance
  - Period: Last 30 Days
  - Frequency: Monthly
  - Start Date: 2026-08-01
  - Recipients: henry.lim@audit.gov.sg, security@agency.gov.sg
- **Test IDs:**
  - `modal__schedule-report-type`
  - `modal__schedule-period`
  - `modal__schedule-frequency`
  - `modal__schedule-start-date`
  - `modal__schedule-recipients`
- **Expected:** Schedule configured

### Step 19: Save Schedule
- **Action:** Click "Save Schedule" button
- **Test ID:** `modal__save-schedule-button`
- **Expected:**
  - Schedule saved
  - Success notification appears
  - First report will be generated on schedule

### Step 20: View Scheduled Reports
- **Action:** Click on "Scheduled Reports" tab
- **Test ID:** `reports-dashboard__tab-scheduled`
- **Expected:** Scheduled reports list shows:
  - Monthly Compliance Report
  - Next run: 2026-08-01
  - Recipients: 2
  - Status: Active

## Postconditions
- Compliance reports can be generated
- Anomalies are automatically detected
- Reports include comprehensive analysis
- Reports can be exported in multiple formats
- Recurring reports can be scheduled
- All report activities are tracked

## Test Assertions
- [ ] Auditor can access Reports Dashboard
- [ ] New reports can be created
- [ ] Report parameters can be configured
- [ ] Report sections can be selected
- [ ] Reports can be generated
- [ ] Generation status is visible
- [ ] Generated reports can be viewed
- [ ] Report sections are accessible
- [ ] Access log summary is available
- [ ] Audit trail analysis is available
- [ ] Anomaly detection works
- [ ] Compliance checklist is available
- [ ] Report notes can be added
- [ ] Notes are saved and visible
- [ ] Reports can be exported
- [ ] Export options can be configured
- [ ] PDF export works
- [ ] Recurring reports can be scheduled
- [ ] Schedule can be configured
- [ ] Schedules are saved
- [ ] Scheduled reports list is visible
- [ ] All actions create audit entries

## Error Cases
- **Report Generation Failure:** System error during generation
  - **Expected:** Error notification, retry option, partial results if available
- **Invalid Period:** Start date in future
  - **Expected:** Validation error
- **No Recipients:** Attempt to schedule with no recipients
  - **Expected:** Validation error

## Performance Considerations
- Reports dashboard should load within 400ms
- Report generation should complete within 5-10 seconds depending on scope
- Report viewing should be immediate
- PDF export should complete within 3-5 seconds
- Schedule saving should be immediate
