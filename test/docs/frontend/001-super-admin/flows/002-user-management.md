# Flow 002: User Management and Approval

## Persona
**001-super-admin** - Alice Chen

## Flow Overview
Super Administrator manages user lifecycle including approval, rejection, tombstoning, and affiliation changes.

## Preconditions
- User is logged in as Super Administrator (Alice Chen)
- User has `full_admin` role
- There are pending user signups
- User is on the Admin Panel

## Steps

### Step 1: Navigate to Users Tab
- **Action:** Click on "Users" tab in Admin Panel
- **Test ID:** `admin-panel__tab-users`
- **Expected:** Users tab opens with list of users

### Step 2: View Pending Users
- **Action:** Click on "Pending" filter
- **Test ID:** `admin-users__filter-pending`
- **Expected:** Only users with pending status are displayed

### Step 3: Select a Pending User
- **Action:** Click on first pending user in the list
- **Test ID:** `admin-users__row-pending` (first row)
- **Expected:** User detail panel opens

### Step 4: Review User Information
- **Action:** Review user details (email, name, affiliation request)
- **Test IDs:** 
  - `admin-user-detail__email`
  - `admin-user-detail__name`
  - `admin-user-detail__affiliation`
- **Expected:** All user information is displayed

### Step 5: Approve User
- **Action:** Click Approve button
- **Test ID:** `admin-user-detail__approve-button`
- **Expected:** 
  - User status changes to "active"
  - User can now log in
  - Success notification appears
  - Audit log entry created
  - User receives welcome email (if configured)

### Step 6: Navigate Back to List
- **Action:** Click back or close detail panel
- **Expected:** Returns to users list

### Step 7: Filter for Active Users
- **Action:** Click on "Active" filter
- **Test ID:** `admin-users__filter-active`
- **Expected:** Only active users are displayed

### Step 8: Select an Active User
- **Action:** Click on an active user
- **Expected:** User detail panel opens

### Step 9: Change User Affiliation
- **Action:** Click "Change Affiliation" button
- **Test ID:** `admin-user-detail__change-affiliation-button`
- **Expected:** Affiliation change modal opens

### Step 10: Select New Affiliation
- **Action:** Change affiliation from "vendor" to "agency"
- **Test ID:** `admin-user-detail__affiliation-select`
- **Expected:** Affiliation dropdown shows options

### Step 11: Save Affiliation Change
- **Action:** Click Save button
- **Test ID:** `admin-user-detail__affiliation-save-button`
- **Expected:** 
  - Affiliation updates to "agency"
  - Success notification appears
  - Audit log entry created

### Step 12: Tombstone a User
- **Action:** Click "Tombstone" button for a user
- **Test ID:** `admin-user-detail__tombstone-button`
- **Expected:** 
  - Confirmation modal appears
  - User status changes to "tombstoned"
  - User cannot log in
  - All user sessions are invalidated
  - All user requests are auto-cancelled
  - Audit log entry created

### Step 13: Untombstone a User
- **Action:** Click "Untombstone" button for a tombstoned user
- **Test ID:** `admin-user-detail__untombstone-button`
- **Expected:** 
  - User status changes back to "active"
  - User can log in again
  - Success notification appears
  - Audit log entry created

## Postconditions
- User lifecycle is properly managed
- All changes are audited
- System remains in consistent state

## Test Assertions
- [ ] Super Admin can view all users
- [ ] Super Admin can filter users by status
- [ ] Super Admin can approve pending users
- [ ] Super Admin can reject pending users
- [ ] Super Admin can change user affiliation
- [ ] Super Admin can tombstone users
- [ ] Super Admin can untombstone users
- [ ] All changes create audit log entries
- [ ] Tombstoned users cannot log in
- [ ] Tombstoned user requests are auto-cancelled

## Error Cases
- **No Pending Users:** No pending users to approve
  - **Expected:** Empty state message displayed
- **Invalid Affiliation:** Attempt to set invalid affiliation
  - **Expected:** Validation error, change not saved
- **Unauthorized:** Non-admin user attempts to access
  - **Expected:** 403 Forbidden error

## Performance Considerations
- Users list should load within 500ms
- User detail should load within 300ms
- All operations should complete within 500ms
