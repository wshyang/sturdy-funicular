# Flow 001: System Configuration Management

## Persona
**001-super-admin** - Alice Chen

## Flow Overview
Super Administrator configures global application settings including feature toggles, cron schedules, and pagination limits.

## Preconditions
- User is logged in as Super Administrator (Alice Chen)
- User has `full_admin` role
- User is on the Admin Panel

## Steps

### Step 1: Navigate to App Settings Tab
- **Action:** Click on "Settings" tab in Admin Panel
- **Test ID:** `admin-panel__tab-settings`
- **Expected:** Settings tab opens with App Settings section visible

### Step 2: View Current Settings
- **Action:** Scroll through the App Settings list
- **Test ID:** `admin-app-settings__table`
- **Expected:** All current settings are displayed with their values
- **Data:** Settings include:
  - `access_log_list_cap`
  - `sent_notification_list_cap`
  - `cron_*` schedules
  - `email_delivery_enabled`
  - `aws_integration_enabled`
  - `slack_integration_enabled`

### Step 3: Edit a Setting
- **Action:** Click edit button for `access_log_list_cap`
- **Test ID:** `admin-app-settings__edit-button-access_log_list_cap`
- **Expected:** Edit modal opens with current value (100)

### Step 4: Update Setting Value
- **Action:** Change value from 100 to 200
- **Test ID:** `admin-app-settings__value-input`
- **Expected:** Input field accepts the new value

### Step 5: Save Setting
- **Action:** Click Save button
- **Test ID:** `admin-app-settings__save-button`
- **Expected:** 
  - Modal closes
  - Setting value updates to 200
  - Success notification appears
  - Audit log entry created

### Step 6: Verify Setting Applied
- **Action:** Refresh the page or navigate away and back
- **Expected:** Setting persists as 200

### Step 7: Edit Multiple Settings
- **Action:** Edit `email_delivery_enabled` to true
- **Expected:** Setting saves successfully

### Step 8: Test Feature Toggle
- **Action:** Trigger an email notification (if configured)
- **Expected:** Email delivery is now enabled

## Postconditions
- System settings are updated
- Changes are persisted in database
- Audit trail records all modifications

## Test Assertions
- [ ] Super Admin can access App Settings tab
- [ ] All settings are visible
- [ ] Settings can be edited
- [ ] Changes are saved successfully
- [ ] Audit log entries are created for each change
- [ ] Settings persist across sessions
- [ ] Feature toggles take effect immediately

## Error Cases
- **Invalid Value:** Attempt to set string setting to non-string value
  - **Expected:** Validation error, setting not saved
- **Unauthorized:** Non-admin user attempts to access
  - **Expected:** 403 Forbidden error

## Performance Considerations
- Settings list should load within 500ms
- Settings updates should complete within 200ms
