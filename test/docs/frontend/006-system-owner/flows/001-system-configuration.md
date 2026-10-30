# Flow 001: System Configuration and Settings Management

## Persona
**006-system-owner** - Frank Wong

## Flow Overview
System Owner configures and manages settings for owned systems, including system metadata, access controls, and maintenance windows.

## Preconditions
- User is logged in as System Owner (Frank Wong)
- User has agency affiliation
- User owns system "Agency-Web-01"
- User is on the Systems Dashboard

## Steps

### Step 1: Navigate to Owned Systems
- **Action:** Click on "My Systems" filter
- **Test ID:** `systems-dashboard__filter-my-systems`
- **Expected:** Dashboard shows only systems owned by Frank Wong

### Step 2: Select System to Configure
- **Action:** Click on "Agency-Web-01" system card
- **Test ID:** `system-card-Agency-Web-01`
- **Expected:** System detail page opens

### Step 3: View Current Configuration
- **Action:** Scroll through system configuration
- **Test IDs:**
  - `system-detail__name`
  - `system-detail__description`
  - `system-detail__cluster`
  - `system-detail__team`
  - `system-detail__criticality`
  - `system-detail__maintenance-window`
- **Expected:** Current configuration visible:
  - Name: Agency-Web-01
  - Description: Primary agency web server
  - Cluster: Agency-Production
  - Team: Agency-Web-Team
  - Criticality: High
  - Maintenance Window: Sundays 2-4 AM

### Step 4: Edit System Description
- **Action:** Click "Edit" button
- **Test ID:** `system-detail__edit-button`
- **Expected:** Edit modal opens with current values

### Step 5: Update Description
- **Action:** Change description to "Primary agency web server - Updated for 2026 Q3"
- **Test ID:** `modal__description-input`
- **Expected:** New description accepted

### Step 6: Update Criticality
- **Action:** Change criticality from "High" to "Critical"
- **Test ID:** `modal__criticality-select`
- **Expected:** Criticality selection updates

### Step 7: Save Changes
- **Action:** Click "Save" button
- **Test ID:** `modal__save-button`
- **Expected:**
  - Modal closes
  - Description and criticality update in display
  - Success notification appears
  - Audit log entry created

### Step 8: Configure Maintenance Window
- **Action:** Click "Edit Maintenance Window" button
- **Test ID:** `system-detail__edit-maintenance-button`
- **Expected:** Maintenance window modal opens

### Step 9: Set New Maintenance Window
- **Action:** Select new window:
  - Day: Saturdays
  - Start Time: 1:00 AM
  - End Time: 3:00 AM
- **Test IDs:**
  - `modal__maintenance-day-select`
  - `modal__maintenance-start-time-input`
  - `modal__maintenance-end-time-input`
- **Expected:** New window configured

### Step 10: Save Maintenance Window
- **Action:** Click "Save" button
- **Test ID:** `modal__save-button`
- **Expected:**
  - Maintenance window updates
  - Modal closes
  - Success notification appears

### Step 11: Manage System Delegates
- **Action:** Click "Manage Delegates" button
- **Test ID:** `system-detail__manage-delegates-button`
- **Expected:** Delegates management panel opens

### Step 12: Add Delegate
- **Action:** Click "Add Delegate" and select "Grace Tan"
- **Test IDs:**
  - `delegates-panel__add-delegate-button`
  - `modal__delegate-select`
- **Expected:** Grace Tan added as delegate

### Step 13: Set Delegate Permissions
- **Action:** For Grace Tan, enable:
  - Can Request Access: Yes
  - Can Approve Requests: No
  - Can Manage System: No
- **Test IDs:**
  - `delegates-panel__delegate-permission-can-request-Grace Tan`
  - `delegates-panel__delegate-permission-can-approve-Grace Tan`
  - `delegates-panel__delegate-permission-can-manage-Grace Tan`
- **Expected:** Permissions configured

### Step 14: Save Delegate Changes
- **Action:** Click "Save Delegates" button
- **Test ID:** `delegates-panel__save-button`
- **Expected:**
  - Changes saved
  - Success notification appears
  - Audit log entry created

### Step 15: Configure Access Controls
- **Action:** Click "Access Controls" tab
- **Test ID:** `system-detail__tab-access-controls`
- **Expected:** Access controls panel opens

### Step 16: Set Request Approval Requirements
- **Action:** Configure:
  - Require L1 Approval: Yes
  - Require L2 Approval: Yes (for high-risk)
  - Max Request Duration: 48 hours
  - Auto-Revoke After Expiration: Yes
- **Test IDs:**
  - `access-controls__require-l1-toggle`
  - `access-controls__require-l2-toggle`
  - `access-controls__max-duration-input`
  - `access-controls__auto-revoke-toggle`
- **Expected:** Access controls configured

### Step 17: Save Access Controls
- **Action:** Click "Save Access Controls" button
- **Test ID:** `access-controls__save-button`
- **Expected:**
  - Configuration saved
  - Success notification appears
  - Audit log entry created

## Postconditions
- System configuration is updated
- Maintenance window is set
- Delegates are configured with appropriate permissions
- Access controls are configured
- All changes are audited

## Test Assertions
- [ ] System Owner can view owned systems
- [ ] System details are visible
- [ ] System can be edited
- [ ] Description can be updated
- [ ] Criticality can be changed
- [ ] Changes are saved correctly
- [ ] Maintenance window can be configured
- [ ] Delegates can be added
- [ ] Delegate permissions can be set
- [ ] Delegate changes are saved
- [ ] Access controls can be configured
- [ ] Access control changes are saved
- [ ] All changes create audit entries
- [ ] Cannot configure systems not owned

## Error Cases
- **Invalid Maintenance Window:** End time before start time
  - **Expected:** Validation error, cannot save
- **Duplicate Delegate:** Attempt to add same user twice
  - **Expected:** Warning message, duplicate not added
- **Invalid Max Duration:** Set to 0 or negative
  - **Expected:** Validation error, cannot save
- **Unauthorized:** Non-owner attempts to configure system
  - **Expected:** 403 Forbidden error

## Performance Considerations
- System details should load within 300ms
- Edit operations should complete within 400ms
- Delegate management should be responsive
- Save operations should complete within 500ms
