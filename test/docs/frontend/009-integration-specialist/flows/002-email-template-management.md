# Flow 002: Email Template Management

## Persona
**009-integration-specialist** - Irene Koh

## Flow Overview
Integration Specialist creates and manages email notification templates for all system triggers, including testing and versioning.

## Preconditions
- User is logged in as Integration Specialist (Irene Koh)
- User has admin affiliation
- User has email template management capabilities
- User is on the Admin Panel > Email Templates page

## Steps

### Step 1: Navigate to Email Templates
- **Action:** Click on "Email Templates" tab in Admin Panel
- **Test ID:** `admin-panel__tab-email-templates`
- **Expected:** Email Templates page opens with list of all templates

### Step 2: View Existing Templates
- **Action:** Scroll through template list
- **Test ID:** `email-templates__table`
- **Expected:** Templates visible:
  - request_submitted - Active
  - request_approved_l1 - Active
  - request_approved_l2 - Active
  - request_rejected - Active
  - user_invited - Active
  - password_reset - Active
  - ... (all trigger keys from EmailTriggerKey type)

### Step 3: Create New Template
- **Action:** Click "Create Template" button
- **Test ID:** `email-templates__create-button`
- **Expected:** Create template modal opens

### Step 4: Select Trigger
- **Action:** Select "request_approved_owner" from trigger dropdown
- **Test ID:** `modal__trigger-select`
- **Expected:** Trigger selected, template key auto-filled

### Step 5: Enter Template Details
- **Action:** Fill in:
  - Name: Owner Approval Notification
  - Subject: Your Break-Glass Request Has Been Approved by System Owner
  - Description: Notification sent when system owner approves a request
- **Test IDs:**
  - `modal__template-name-input`
  - `modal__template-subject-input`
  - `modal__template-description-input`
- **Expected:** Details accepted

### Step 6: Create Email Body
- **Action:** Use template editor to create body:
```html
<html>
<body>
<h1>Break-Glass Request Approved</h1>
<p>Hello {{recipient_name}},</p>
<p>Your break-glass request <strong>{{request_number}}</strong> has been approved by the system owner.</p>
<p><strong>System:</strong> {{system_name}}</p>
<p><strong>Expiration:</strong> {{expiration_time}}</p>
<p><strong>Credentials:</strong></p>
<ul>
{{#each credentials}}
<li>{{credential_type}} for {{hostname}} ({{username}})</li>
{{/each}}
</ul>
<p>You can access your credentials at: <a href="{{access_link}}">Access Credentials</a></p>
<p>If you did not request this, please contact support immediately.</p>
</body>
</html>
```
- **Test ID:** `modal__template-body-editor`
- **Expected:** Template body created with variables

### Step 7: Preview Template
- **Action:** Click "Preview" button
- **Test ID:** `modal__preview-button`
- **Expected:** Preview modal opens showing rendered template with sample data:
  - recipient_name: John Doe
  - request_number: REQ-00123
  - system_name: Agency-Web-01
  - expiration_time: 2026-07-31 23:59:59
  - credentials: [2 items]
  - access_link: https://firefighter.example.com/requests/REQ-00123/credentials

### Step 8: Save Template
- **Action:** Click "Save Template" button
- **Test ID:** `modal__save-button`
- **Expected:**
  - Template saved
  - Modal closes
  - New template appears in list
  - Success notification appears
  - Audit log entry created

### Step 9: Activate Template
- **Action:** Toggle "Active" switch for new template
- **Test ID:** `email-templates__active-toggle-request_approved_owner`
- **Expected:**
  - Template status updates to Active
  - Previous template for same trigger is deactivated (if any)
  - Success notification appears

### Step 10: Test Template
- **Action:** Click "Test" button for template
- **Test ID:** `email-templates__test-button-request_approved_owner`
- **Expected:** Test modal opens

### Step 11: Configure Test
- **Action:** Enter test data:
  - Recipient Email: irene.koh@integration.gov.sg
  - Test Data (JSON):
```json
{
  "recipient_name": "Irene Koh",
  "request_number": "REQ-TEST-001",
  "system_name": "Test System",
  "expiration_time": "2026-08-01 12:00:00",
  "credentials": [
    {"credential_type": "Password", "hostname": "test.db.local", "username": "admin"}
  ],
  "access_link": "https://test.example.com"
}
```
- **Test IDs:**
  - `modal__test-recipient-input`
  - `modal__test-data-input`
- **Expected:** Test data configured

### Step 12: Send Test Email
- **Action:** Click "Send Test Email" button
- **Test ID:** `modal__send-test-button`
- **Expected:**
  - Test email generated
  - Email sent to recipient
  - Success notification: "Test email sent to irene.koh@integration.gov.sg"
  - Test email logged in sent_notifications

### Step 13: Verify Test Email
- **Action:** Navigate to Sent Emails and filter by recipient
- **Test ID:** `admin-panel__tab-sent-emails`
- **Expected:** Test email visible in list with:
  - Subject: Your Break-Glass Request Has Been Approved by System Owner
  - Recipient: irene.koh@integration.gov.sg
  - Status: logged (or delivered if email delivery enabled)

### Step 14: Edit Existing Template
- **Action:** Click "Edit" button for "request_submitted" template
- **Test ID:** `email-templates__edit-button-request_submitted`
- **Expected:** Edit modal opens with current template

### Step 15: Update Template Subject
- **Action:** Change subject to "New Break-Glass Request Submitted - Action Required"
- **Test ID:** `modal__template-subject-input`
- **Expected:** Subject updated

### Step 16: Update Template Body
- **Action:** Add urgency indicator to body:
```html
<p style="color: #d32f2f; font-weight: bold;">
  URGENT: This request requires your attention.
</p>
```
- **Test ID:** `modal__template-body-editor`
- **Expected:** Body updated

### Step 17: Save Edits
- **Action:** Click "Save" button
- **Test ID:** `modal__save-button`
- **Expected:**
  - Template updated
  - Modal closes
  - Success notification appears
  - Audit log entry created

### Step 18: Version Management
- **Action:** Click "Versions" button for template
- **Test ID:** `email-templates__versions-button-request_submitted`
- **Expected:** Version history modal opens showing:
  - Version 2: Current (just edited)
  - Version 1: Previous version
  - Changes: Subject updated, body updated

### Step 19: Restore Previous Version
- **Action:** Click "Restore" on Version 1
- **Test ID:** `modal__version-restore-button-1`
- **Expected:** Confirmation modal appears

### Step 20: Confirm Restore
- **Action:** Click "Confirm Restore" button
- **Test ID:** `modal__confirm-restore-button`
- **Expected:**
  - Template restored to Version 1
  - New Version 3 created
  - Success notification appears

### Step 21: Deactivate Old Template
- **Action:** Toggle "Active" switch OFF for old template
- **Test ID:** `email-templates__active-toggle-old-template`
- **Expected:**
  - Template deactivated
  - Success notification appears

## Postconditions
- Email templates can be created
- Templates can be tested
- Templates can be edited
- Version history is maintained
- Templates can be activated/deactivated
- All changes are audited

## Test Assertions
- [ ] Integration Specialist can access email templates page
- [ ] Existing templates are visible
- [ ] New templates can be created
- [ ] Trigger can be selected
- [ ] Template details can be entered
- [ ] Template body can be edited with variables
- [ ] Template can be previewed
- [ ] Template can be saved
- [ ] Template appears in list
- [ ] Template can be activated
- [ ] Template can be tested
- [ ] Test data can be configured
- [ ] Test email can be sent
- [ ] Test email is logged
- [ ] Existing templates can be edited
- [ ] Template updates are saved
- [ ] Version history is visible
- [ ] Previous versions can be restored
- [ ] Templates can be deactivated
- [ ] All actions create audit entries

## Error Cases
- **Duplicate Trigger:** Attempt to create template with existing active trigger
  - **Expected:** Warning, existing template shown, option to deactivate old one
- **Invalid Template:** Template with missing required variables
  - **Expected:** Validation error, cannot save
- **Test Email Failure:** Email delivery fails
  - **Expected:** Error message, but test still logged
- **Empty Body:** Attempt to save with empty body
  - **Expected:** Validation error

## Performance Considerations
- Email templates page should load within 400ms
- Template creation should be responsive
- Preview should render within 500ms
- Template save should complete within 500ms
- Test email should be sent within 1 second
- Version history should load within 300ms
