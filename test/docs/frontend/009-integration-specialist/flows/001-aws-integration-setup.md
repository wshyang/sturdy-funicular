# Flow 001: AWS Integration Configuration

## Persona
**009-integration-specialist** - Irene Koh

## Flow Overview
Integration Specialist configures AWS integration for credential delivery, including S3 bucket configuration, IAM roles, and secret delivery settings.

## Preconditions
- User is logged in as Integration Specialist (Irene Koh)
- User has admin affiliation
- User has integration configuration capabilities
- User is on the Admin Panel > Integrations page

## Steps

### Step 1: Navigate to Integrations
- **Action:** Click on "Integrations" tab in Admin Panel
- **Test ID:** `admin-panel__tab-integrations`
- **Expected:** Integrations page opens with all integration options

### Step 2: Select AWS Integration
- **Action:** Click on "AWS" integration card
- **Test ID:** `integrations__aws-card`
- **Expected:** AWS integration configuration page opens

### Step 3: Enable AWS Integration
- **Action:** Toggle "Enable AWS Integration" to ON
- **Test ID:** `aws-integration__enable-toggle`
- **Expected:** AWS configuration form becomes enabled

### Step 4: Configure AWS Region
- **Action:** Select "ap-southeast-1" from region dropdown
- **Test ID:** `aws-integration__region-select`
- **Expected:** Region selected

### Step 5: Configure S3 Bucket
- **Action:** Enter bucket details:
  - Bucket Name: firefighter-credentials-prod
  - KMS Key ID: alias/firefighter-credentials-key
- **Test IDs:**
  - `aws-integration__bucket-name-input`
  - `aws-integration__kms-key-input`
- **Expected:** Bucket configuration accepted

### Step 6: Test S3 Connection
- **Action:** Click "Test S3 Connection" button
- **Test ID:** `aws-integration__test-s3-button`
- **Expected:**
  - Connection test runs
  - Success notification: "S3 connection successful"
  - Bucket accessibility confirmed

### Step 7: Configure IAM Role
- **Action:** Enter IAM role ARN:
  - Role ARN: arn:aws:iam::123456789012:role/Firefighter-Credential-Delivery
- **Test ID:** `aws-integration__iam-role-input`
- **Expected:** Role ARN accepted

### Step 8: Configure Secret Delivery
- **Action:** Configure delivery settings:
  - Delivery Method: S3 (already selected)
  - Enable Direct Delivery: Yes
  - Max Retries: 3
  - Retry Delay (seconds): 60
- **Test IDs:**
  - `aws-integration__delivery-method-select`
  - `aws-integration__direct-delivery-toggle`
  - `aws-integration__max-retries-input`
  - `aws-integration__retry-delay-input`
- **Expected:** Delivery settings configured

### Step 9: Configure Polling Settings
- **Action:** Configure background polling:
  - Enable Polling: Yes
  - Poll Interval (minutes): 5
  - Batch Size: 10
- **Test IDs:**
  - `aws-integration__polling-toggle`
  - `aws-integration__poll-interval-input`
  - `aws-integration__batch-size-input`
- **Expected:** Polling settings configured

### Step 10: Test Full AWS Connection
- **Action:** Click "Test Full Connection" button
- **Test ID:** `aws-integration__test-full-button`
- **Expected:**
  - Full AWS connection test runs
  - Tests S3, IAM, and delivery permissions
  - Success notification: "AWS integration fully configured and working"
  - Test results show all checks passed

### Step 11: Save AWS Configuration
- **Action:** Click "Save Configuration" button
- **Test ID:** `aws-integration__save-button`
- **Expected:**
  - Configuration saved
  - AWS integration status updates to "Configured"
  - Success notification appears
  - Audit log entry created

### Step 12: Verify Configuration
- **Action:** Refresh page
- **Test ID:** `aws-integration__status-indicator`
- **Expected:** Status shows "Configured" with green indicator

### Step 13: Test Credential Delivery
- **Action:** Click "Test Credential Delivery" button
- **Test ID:** `aws-integration__test-delivery-button`
- **Expected:**
  - Test credential is generated
  - Delivery to S3 is attempted
  - Success notification: "Test credential delivered successfully"
  - Test credential details visible

### Step 14: View Delivery Logs
- **Action:** Click "Delivery Logs" tab
- **Test ID:** `aws-integration__tab-delivery-logs`
- **Expected:** Delivery logs show:
  - Test delivery entry
  - Timestamp
  - Status: Success
  - S3 Object Key

### Step 15: Configure Notification Settings
- **Action:** Click "Notifications" tab
- **Test ID:** `aws-integration__tab-notifications`
- **Expected:** Notification settings panel opens

### Step 16: Enable Delivery Notifications
- **Action:** Configure:
  - Notify on Success: Yes
  - Notify on Failure: Yes
  - Notification Channels: Email, Slack
- **Test IDs:**
  - `aws-integration__notify-success-toggle`
  - `aws-integration__notify-failure-toggle`
  - `aws-integration__notification-channels-select`
- **Expected:** Notification settings configured

### Step 17: Save Notification Settings
- **Action:** Click "Save Notifications" button
- **Test ID:** `aws-integration__save-notifications-button`
- **Expected:**
  - Settings saved
  - Success notification appears

## Postconditions
- AWS integration is fully configured
- S3 bucket is accessible
- IAM role is configured
- Secret delivery is working
- Polling is enabled
- Notifications are configured
- All configuration is audited

## Test Assertions
- [ ] Integration Specialist can access integrations page
- [ ] AWS integration can be selected
- [ ] AWS integration can be enabled
- [ ] AWS region can be configured
- [ ] S3 bucket can be configured
- [ ] S3 connection can be tested
- [ ] IAM role can be configured
- [ ] Delivery settings can be configured
- [ ] Polling settings can be configured
- [ ] Full AWS connection can be tested
- [ ] Configuration can be saved
- [ ] Configuration persists
- [ ] Status indicator works
- [ ] Credential delivery can be tested
- [ ] Delivery logs are visible
- [ ] Notification settings can be configured
- [ ] Notification settings are saved
- [ ] All actions create audit entries

## Error Cases
- **Invalid Region:** Select non-existent region
  - **Expected:** Validation error
- **Bucket Not Accessible:** Bucket doesn't exist or permissions wrong
  - **Expected:** Connection test fails with error message
- **Invalid Role ARN:** Malformed ARN
  - **Expected:** Validation error
- **Polling Already Running:** Attempt to enable polling when already running
  - **Expected:** Warning message, current polling disabled first

## Performance Considerations
- AWS integration page should load within 400ms
- Connection tests should complete within 2 seconds
- Configuration save should complete within 500ms
- Credential delivery test should complete within 3 seconds
- Delivery logs should load within 300ms
