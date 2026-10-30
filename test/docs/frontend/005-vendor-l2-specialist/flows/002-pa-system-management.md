# Flow 002: Primary Authority (PA) System Management

## Persona
**005-vendor-l2-specialist** - Evelyn Koh

## Flow Overview
Vendor L2 Specialist manages Primary Authority (PA) system mappings, including adding/removing systems and managing delegate access for high-security systems.

## Preconditions
- User is logged in as Vendor L2 Specialist (Evelyn Koh)
- User has vendor affiliation
- User has PA management capabilities
- User is on the Admin Panel > Systems page

## Steps

### Step 1: Navigate to Systems Admin
- **Action:** Click on "Systems" tab in Admin Panel
- **Test ID:** `admin-panel__tab-systems`
- **Expected:** Systems administration page opens

### Step 2: Filter for PA Systems
- **Action:** Select "PA Systems" from system type filter
- **Test ID:** `admin-systems__filter-pa`
- **Expected:** Only Primary Authority systems are displayed

### Step 3: View Existing PA System
- **Action:** Click on "PA-Vendor-Core-01" system
- **Test ID:** `admin-systems__row-PA-Vendor-Core-01`
- **Expected:** System detail panel opens showing:
  - System name: PA-Vendor-Core-01
  - Description: Primary Authority Core System
  - Cluster: Vendor-Infrastructure
  - Team: Vendor-Infrastructure
  - PA Status: Active
  - Delegates: 2 (David Ng, Frank Wong)

### Step 4: Add New PA System
- **Action:** Click "Add PA System" button
- **Test ID:** `admin-systems__add-pa-system-button`
- **Expected:** Add PA System modal opens

### Step 5: Enter PA System Details
- **Action:** Fill in form fields:
  - Name: PA-Vendor-New-01
  - Description: New Primary Authority System
  - Cluster: Vendor-Infrastructure
  - Team: Vendor-Infrastructure
  - Criticality: High
- **Test IDs:**
  - `modal__pa-system-name-input`
  - `modal__pa-system-description-input`
  - `modal__pa-system-cluster-select`
  - `modal__pa-system-team-select`
  - `modal__pa-system-criticality-select`
- **Expected:** All fields accept input

### Step 6: Configure PA Settings
- **Action:** Enable PA toggle and set options:
  - PA Enabled: Yes
  - Auto-Approve: No
  - Require L2 Approval: Yes
- **Test IDs:**
  - `modal__pa-enabled-toggle`
  - `modal__pa-auto-approve-toggle`
  - `modal__pa-require-l2-toggle`
- **Expected:** PA-specific settings are configured

### Step 7: Add Initial Delegate
- **Action:** Click "Add Delegate" in modal
- **Test ID:** `modal__add-delegate-button`
- **Expected:** Delegate selection dropdown appears

### Step 8: Select Delegate
- **Action:** Select "David Ng" from dropdown
- **Test ID:** `modal__delegate-select`
- **Expected:** David Ng added as delegate

### Step 9: Save PA System
- **Action:** Click "Save" button
- **Test ID:** `modal__save-button`
- **Expected:**
  - Modal closes
  - New PA system appears in list
  - Success notification appears
  - Audit log entry created

### Step 10: Manage Existing Delegates
- **Action:** Click on PA-Vendor-Core-01 system again
- **Test ID:** `admin-systems__row-PA-Vendor-Core-01`
- **Expected:** System detail panel opens

### Step 11: Add Additional Delegate
- **Action:** Click "Add Delegate" button
- **Test ID:** `system-detail__add-delegate-button`
- **Expected:** Delegate selection modal opens

### Step 12: Select and Add Delegate
- **Action:** Select "Grace Tan" and click Add
- **Test IDs:**
  - `modal__delegate-select`
  - `modal__add-delegate-confirm-button`
- **Expected:** Grace Tan added as delegate

### Step 13: Remove Delegate
- **Action:** Click remove icon next to "Frank Wong"
- **Test ID:** `system-detail__delegate-remove-Frank Wong`
- **Expected:** Confirmation modal appears

### Step 14: Confirm Removal
- **Action:** Click "Confirm Removal" in modal
- **Test ID:** `modal__confirm-removal-button`
- **Expected:**
  - Frank Wong removed from delegates list
  - Success notification appears
  - Audit log entry created

### Step 15: Deactivate PA System
- **Action:** Toggle PA Enabled to Off
- **Test ID:** `system-detail__pa-enabled-toggle`
- **Expected:** Confirmation modal appears warning about impact

### Step 16: Confirm Deactivation
- **Action:** Type "DEACTIVATE" in confirmation field and click Confirm
- **Test IDs:**
  - `modal__deactivate-confirmation-input`
  - `modal__confirm-deactivation-button`
- **Expected:**
  - PA status updates to Inactive
  - All pending requests for this system are rejected
  - Audit log entry created

## Postconditions
- PA system is created and configured
- Delegates are managed correctly
- PA system can be deactivated when needed
- All changes are audited

## Test Assertions
- [ ] Vendor L2 can navigate to PA systems
- [ ] PA systems can be filtered
- [ ] PA system details are visible
- [ ] New PA system can be added
- [ ] PA settings can be configured
- [ ] Initial delegates can be added during creation
- [ ] Delegates can be added to existing PA systems
- [ ] Delegates can be removed
- [ ] PA system can be deactivated
- [ ] Deactivation requires confirmation
- [ ] All changes create audit log entries
- [ ] Cannot deactivate PA system without confirmation

## Error Cases
- **Invalid Name:** Attempt to create PA system with duplicate name
  - **Expected:** Validation error, cannot save
- **No Delegates:** Attempt to save PA system without any delegates
  - **Expected:** Warning, but allowed (system owner is implicit delegate)
- **Unauthorized User:** Non-PA user attempts to manage PA systems
  - **Expected:** 403 Forbidden error
- **Remove Last Delegate:** Attempt to remove all delegates
  - **Expected:** Error message, cannot remove last delegate

## Performance Considerations
- PA system list should load within 300ms
- System details should load within 200ms
- Delegate operations should complete within 200ms
- Save operations should complete within 400ms
