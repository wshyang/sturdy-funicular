# Flow 003: Manual Credential Issuance

## Persona
**005-vendor-l2-specialist** - Evelyn Koh

## Flow Overview
Vendor L2 Specialist manually issues credentials for approved requests, particularly for complex scenarios or when automatic issuance fails.

## Preconditions
- User is logged in as Vendor L2 Specialist (Evelyn Koh)
- User has vendor affiliation
- Request REQ-00201 has been approved
- Credentials have not been automatically issued (or need re-issuance)
- User is on the Request Detail page

## Steps

### Step 1: Open Approved Request
- **Action:** Navigate to request REQ-00201
- **Test ID:** `request-card-REQ-00201`
- **Expected:** Request detail page shows approved status

### Step 2: Check Credential Status
- **Action:** Scroll to credentials section
- **Test ID:** `request-detail__credentials-section`
- **Expected:** Shows:
  - 2 credential items
  - Status: "Pending Issuance" for both
  - Issue buttons enabled

### Step 3: Issue First Credential
- **Action:** Click "Issue" button for first credential (Database Password)
- **Test ID:** `request-detail__credential-issue-button-0`
- **Expected:** Issue credential modal opens with:
  - Credential type: Database Password
  - Host: db03.vendor.local
  - Username: admin
  - Status: Ready to issue

### Step 4: Customize Credential Details
- **Action:** Modify details if needed:
  - Custom password: [generate random]
  - Expiration: 24 hours (matches request expiration)
  - Notes: "For schema migration"
- **Test IDs:**
  - `modal__credential-password-input`
  - `modal__credential-expiration-input`
  - `modal__credential-notes-input`
- **Expected:** Customizations accepted

### Step 5: Issue Credential
- **Action:** Click "Issue Credential" button
- **Test ID:** `modal__issue-credential-button`
- **Expected:**
  - Credential status updates to "Issued"
  - Credential details saved
  - Modal closes
  - Success notification appears
  - Audit log entry created

### Step 6: Verify First Credential
- **Action:** Check credential status
- **Test ID:** `request-detail__credential-status-0`
- **Expected:** Shows "Issued" with green checkmark

### Step 7: Issue Second Credential
- **Action:** Click "Issue" button for second credential (SSH Private Key)
- **Test ID:** `request-detail__credential-issue-button-1`
- **Expected:** Issue credential modal opens for SSH key

### Step 8: Generate SSH Key Pair
- **Action:** Click "Generate Key Pair" button
- **Test ID:** `modal__generate-key-pair-button`
- **Expected:**
  - Public and private keys generated
  - Fingerprint displayed
  - Keys can be copied

### Step 9: Issue SSH Credential
- **Action:** Click "Issue Credential" button
- **Test ID:** `modal__issue-credential-button`
- **Expected:**
  - SSH credential status updates to "Issued"
  - Key pair saved securely
  - Modal closes
  - Success notification appears

### Step 10: Verify All Credentials Issued
- **Action:** Check all credential statuses
- **Test IDs:**
  - `request-detail__credential-status-0`
  - `request-detail__credential-status-1`
- **Expected:** Both show "Issued" status

### Step 11: Notify Requester
- **Action:** Click "Notify Requester" button
- **Test ID:** `request-detail__notify-requester-button`
- **Expected:**
  - Notification modal opens
  - Requester (David Ng) receives email notification
  - Notification includes all credential access information
  - Success notification appears

### Step 12: Verify Notification
- **Action:** Navigate to Sent Emails
- **Test ID:** `admin-panel__tab-sent-emails`
- **Expected:** Email to David Ng visible with subject containing REQ-00201

### Step 13: View Issued Credentials
- **Action:** Click "View Issued Credentials" in request detail
- **Test ID:** `request-detail__view-issued-credentials-button`
- **Expected:** Issued credentials panel opens showing:
  - Both credentials with full details
  - Issue timestamps
  - Expiration times
  - Access links (if applicable)

### Step 14: Revoke Credential (Optional)
- **Action:** Click "Revoke" button for first credential
- **Test ID:** `request-detail__credential-revoke-button-0`
- **Expected:** Confirmation modal appears

### Step 15: Confirm Revocation
- **Action:** Type "REVOKE" and click Confirm
- **Test IDs:**
  - `modal__revoke-confirmation-input`
  - `modal__confirm-revocation-button`
- **Expected:**
  - Credential status updates to "Revoked"
  - Access is immediately disabled
  - Audit log entry created
  - Requester receives revocation notification

## Postconditions
- Credentials are manually issued for approved request
- Requester is notified
- All actions are audited
- Credentials can be revoked if needed

## Test Assertions
- [ ] Vendor L2 can open approved requests
- [ ] Credential status is visible
- [ ] Individual credentials can be issued
- [ ] Credential details can be customized
- [ ] Database credentials can be issued
- [ ] SSH key pairs can be generated
- [ ] SSH credentials can be issued
- [ ] All credentials show issued status
- [ ] Requester can be notified
- [ ] Notification email is sent
- [ ] Issued credentials can be viewed
- [ ] Credentials can be revoked
- [ ] Revocation requires confirmation
- [ ] All actions create audit entries

## Error Cases
- **Already Issued:** Attempt to issue already-issued credential
  - **Expected:** Button disabled or shows "Already Issued"
- **Invalid Customization:** Attempt to set invalid expiration
  - **Expected:** Validation error, cannot issue
- **Key Generation Failure:** SSH key generation fails
  - **Expected:** Error message, retry option
- **Notification Failure:** Email notification fails
  - **Expected:** Warning message, but credentials still issued

## Performance Considerations
- Credential issuance should complete within 500ms
- SSH key generation should complete within 300ms
- Notifications should be sent within 1 second
- Revocation should be immediate
