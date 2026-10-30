# Flow 002: Team Member Management

## Persona
**002-agency-l1-team-lead** - Benjamin Lee

## Flow Overview
Agency L1 Team Lead manages team membership, adds new members, removes existing members, and assigns roles.

## Preconditions
- User is logged in as Agency L1 Team Lead (Benjamin Lee)
- User has team_admin role for Agency team
- Agency team exists in the system
- User is on the Admin Panel

## Steps

### Step 1: Navigate to Teams Tab
- **Action:** Click on "Teams" tab in Admin Panel
- **Test ID:** `admin-panel__tab-teams`
- **Expected:** Teams tab opens with list of teams

### Step 2: Select Agency Team
- **Action:** Find and click on "Agency" team
- **Test ID:** `admin-teams__row-Agency`
- **Expected:** Team detail view opens

### Step 3: View Team Members
- **Action:** Scroll to "Team Members" section
- **Test ID:** `admin-team-detail__members-section`
- **Expected:** List of current team members is displayed

### Step 4: Add New Member
- **Action:** Click "Add Member" button
- **Test ID:** `admin-team-detail__add-member-button`
- **Expected:** Add member modal opens

### Step 5: Search for User
- **Action:** Type "David" in user search
- **Test ID:** `modal__user-search-input`
- **Expected:** Users matching "David" are displayed

### Step 6: Select User
- **Action:** Click on "David Ng" from search results
- **Test ID:** `modal__user-search-result-David Ng`
- **Expected:** User is selected, role dropdown appears

### Step 7: Assign Role
- **Action:** Select "member" from role dropdown
- **Test ID:** `modal__role-select`
- **Expected:** Role is selected

### Step 8: Save Member
- **Action:** Click Save button
- **Test ID:** `modal__save-button`
- **Expected:** 
  - David Ng is added to Agency team with member role
  - Success notification appears
  - Audit log entry created

### Step 9: Verify New Member
- **Action:** Scroll to verify David Ng appears in members list
- **Test ID:** `admin-team-detail__member-row-David Ng`
- **Expected:** David Ng is listed as a team member

### Step 10: Change Member Role
- **Action:** Click edit button for David Ng
- **Test ID:** `admin-team-detail__member-edit-David Ng`
- **Expected:** Edit member modal opens

### Step 11: Update Role to Admin
- **Action:** Change role from "member" to "team_admin"
- **Test ID:** `modal__role-select`
- **Expected:** Role dropdown shows options

### Step 12: Save Role Change
- **Action:** Click Save button
- **Test ID:** `modal__save-button`
- **Expected:** 
  - David Ng's role updates to team_admin
  - Success notification appears
  - Audit log entry created

### Step 13: Remove a Member
- **Action:** Click remove button for a different member
- **Test ID:** `admin-team-detail__member-remove-<username>`
- **Expected:** Confirmation modal opens

### Step 14: Confirm Removal
- **Action:** Click Confirm in removal modal
- **Test ID:** `modal__confirm-button`
- **Expected:** 
  - Member is removed from team
  - Success notification appears
  - Audit log entry created

## Postconditions
- Team membership is properly managed
- Members can be added, roles changed, and removed
- All changes are audited
- Team remains in consistent state

## Test Assertions
- [ ] Team Admin can view team members
- [ ] Team Admin can add new members
- [ ] Team Admin can change member roles
- [ ] Team Admin can remove members
- [ ] All changes create audit log entries
- [ ] Cannot add users who don't exist
- [ ] Cannot remove last team admin (if enforced)

## Error Cases
- **User Not Found:** Search for non-existent user
  - **Expected:** No results message
- **Already Member:** Attempt to add user already in team
  - **Expected:** Validation error, user not added twice
- **Unauthorized:** Non-team-admin attempts to manage team
  - **Expected:** 403 Forbidden error

## Performance Considerations
- Teams list should load within 300ms
- Team detail should load within 300ms
- User search should return results within 500ms
- Member operations should complete within 500ms
