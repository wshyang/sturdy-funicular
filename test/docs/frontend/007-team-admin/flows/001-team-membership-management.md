# Flow 001: Team Membership Management

## Persona
**007-team-admin** - Grace Tan

## Flow Overview
Team Administrator manages team membership, including adding/removing members, assigning roles, and coordinating team access to systems.

## Preconditions
- User is logged in as Team Administrator (Grace Tan)
- User has agency affiliation
- User administers team "Agency-Web-Team"
- User is on the Teams Dashboard

## Steps

### Step 1: Navigate to Administered Teams
- **Action:** Click on "My Teams" filter
- **Test ID:** `teams-dashboard__filter-my-teams`
- **Expected:** Dashboard shows only teams administered by Grace Tan

### Step 2: Select Team to Manage
- **Action:** Click on "Agency-Web-Team" team card
- **Test ID:** `team-card-Agency-Web-Team`
- **Expected:** Team detail page opens

### Step 3: View Current Membership
- **Action:** Scroll to team members section
- **Test ID:** `team-detail__members-section`
- **Expected:** Shows current members:
  - Alice Chen (Super Admin) - Role: Member
  - Bob Smith (Agency L1) - Role: Member
  - Total: 2 members

### Step 4: Add New Member
- **Action:** Click "Add Member" button
- **Test ID:** `team-detail__add-member-button`
- **Expected:** Add member modal opens with user search

### Step 5: Search for User
- **Action:** Type "Charlie" in search field
- **Test ID:** `modal__user-search-input`
- **Expected:** Search results show:
  - Charlie Brown - charlie.brown@agency.gov.sg - Role: New User

### Step 6: Select User
- **Action:** Click on Charlie Brown
- **Test ID:** `modal__user-search-result-Charlie Brown`
- **Expected:** User selected, added to selection

### Step 7: Assign Role
- **Action:** Select "Member" from role dropdown
- **Test ID:** `modal__member-role-select`
- **Expected:** Role assigned

### Step 8: Add Member
- **Action:** Click "Add to Team" button
- **Test ID:** `modal__add-to-team-button`
- **Expected:**
  - Charlie Brown added to team
  - Modal closes
  - Success notification appears
  - Audit log entry created

### Step 9: Verify New Member
- **Action:** Check team members list
- **Test ID:** `team-detail__members-list`
- **Expected:** Charlie Brown appears in list with "Member" role

### Step 10: Change Member Role
- **Action:** Click role dropdown for Bob Smith
- **Test ID:** `team-detail__member-role-select-Bob Smith`
- **Expected:** Role dropdown opens

### Step 11: Promote to Team Lead
- **Action:** Select "Team Lead" from dropdown
- **Test ID:** `team-detail__member-role-option-Team Lead`
- **Expected:** Role updates to Team Lead

### Step 12: Save Role Change
- **Action:** Click "Save" button (or auto-saves)
- **Test ID:** `team-detail__save-role-button`
- **Expected:**
  - Role change saved
  - Success notification appears
  - Audit log entry created

### Step 13: Remove Member
- **Action:** Click remove icon next to Charlie Brown
- **Test ID:** `team-detail__member-remove-Charlie Brown`
- **Expected:** Confirmation modal appears

### Step 14: Confirm Removal
- **Action:** Type "REMOVE" and click Confirm
- **Test IDs:**
  - `modal__remove-confirmation-input`
  - `modal__confirm-removal-button`
- **Expected:**
  - Charlie Brown removed from team
  - Success notification appears
  - Audit log entry created

### Step 15: Coordinate System Access
- **Action:** Click "System Access" tab
- **Test ID:** `team-detail__tab-system-access`
- **Expected:** System access panel opens showing:
  - Mapped systems: Agency-Web-01, Agency-Web-02
  - Access level: Full

### Step 16: Request Additional System Access
- **Action:** Click "Request System Access" button
- **Test ID:** `team-detail__request-system-access-button`
- **Expected:** System selection modal opens

### Step 17: Select System
- **Action:** Select "Agency-Web-03" from available systems
- **Test ID:** `modal__system-select`
- **Expected:** System selected

### Step 18: Submit Access Request
- **Action:** Click "Submit Request" button
- **Test ID:** `modal__submit-request-button`
- **Expected:**
  - Access request submitted
  - System owner (Frank Wong) receives notification
  - Success notification appears
  - Request appears in pending requests

### Step 19: View Team Statistics
- **Action:** Click "Statistics" tab
- **Test ID:** `team-detail__tab-statistics`
- **Expected:** Statistics panel shows:
  - Total members: 2
  - Active requests: 5
  - Approved requests: 12
  - Rejected requests: 1
  - Systems mapped: 2

## Postconditions
- Team membership is managed correctly
- Members can be added, roles changed, and removed
- System access can be coordinated
- All changes are audited

## Test Assertions
- [ ] Team Admin can view administered teams
- [ ] Team details are visible
- [ ] Current membership is displayed
- [ ] New members can be added via search
- [ ] Users can be selected from search
- [ ] Roles can be assigned during add
- [ ] Members can be added successfully
- [ ] New members appear in list
- [ ] Member roles can be changed
- [ ] Role changes are saved
- [ ] Members can be removed
- [ ] Removal requires confirmation
- [ ] System access can be viewed
- [ ] Additional system access can be requested
- [ ] Access requests are submitted
- [ ] Team statistics are visible
- [ ] All changes create audit entries

## Error Cases
- **User Not Found:** Search for non-existent user
  - **Expected:** "No users found" message
- **Already Member:** Attempt to add user already in team
  - **Expected:** Warning message, duplicate not added
- **Last Admin:** Attempt to remove self as last admin
  - **Expected:** Error message, cannot remove
- **Invalid Role:** Attempt to assign invalid role
  - **Expected:** Validation error

## Performance Considerations
- Team details should load within 300ms
- User search should complete within 400ms
- Member operations should complete within 300ms
- Statistics should load within 500ms
