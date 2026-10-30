# Flow 001: User Signup and Approval Process

## Persona
**010-new-user** - Jack Tan

## Flow Overview
New User completes the signup process, sets up authentication, and awaits approval from administrators before gaining access to the system.

## Preconditions
- User has received signup invitation or knows the signup URL
- User is not yet registered in the system
- User has valid email address: jack.tan@new-contractor.gov.sg
- User is on the Login/Signup page

## Steps

### Step 1: Navigate to Signup Page
- **Action:** User visits the application URL
- **Expected:** Login page displays with "Sign Up" option

### Step 2: Click Sign Up
- **Action:** Click "Sign Up" link or button
- **Test ID:** `login__signup-link`
- **Expected:** Signup page opens with registration form

### Step 3: Enter Personal Information
- **Action:** Fill in personal details:
  - Full Name: Jack Tan
  - Email: jack.tan@new-contractor.gov.sg
  - Phone: +65 9876 5432
  - Department: New Contractor
  - Role: Developer
- **Test IDs:**
  - `signup__full-name-input`
  - `signup__email-input`
  - `signup__phone-input`
  - `signup__department-input`
  - `signup__role-input`
- **Expected:** All fields accept input

### Step 4: Select Affiliation
- **Action:** Select "Contractor" from affiliation dropdown
- **Test ID:** `signup__affiliation-select`
- **Expected:** Affiliation selected

### Step 5: Enter Password
- **Action:** Enter secure password:
  - Password: SecurePassword123!
  - Confirm Password: SecurePassword123!
- **Test IDs:**
  - `signup__password-input`
  - `signup__confirm-password-input`
- **Expected:** Password accepted

### Step 6: Accept Terms and Conditions
- **Action:** Check "I accept the terms and conditions" checkbox
- **Test ID:** `signup__terms-checkbox`
- **Expected:** Checkbox checked, submit button enabled

### Step 7: Submit Registration
- **Action:** Click "Sign Up" button
- **Test ID:** `signup__submit-button`
- **Expected:**
  - Form validates all fields
  - Registration request submitted
  - Loading indicator shows
  - Success message: "Registration submitted! Please check your email for verification."

### Step 8: Check Email for Verification
- **Action:** User checks email inbox
- **Expected:** Email received with:
  - Subject: Verify Your Email - Firefighter Station
  - Verification link
  - Instructions

### Step 9: Click Verification Link
- **Action:** Click verification link in email
- **Expected:**
  - Browser opens to verification page
  - Email verified successfully
  - Message: "Email verified! Your account is pending approval."

### Step 10: Set Up 2FA
- **Action:** User is prompted to set up 2FA
- **Test ID:** `setup-2fa__container`
- **Expected:** 2FA setup page opens with options:
  - Authenticator App (TOTP)
  - Hardware Token

### Step 11: Select Authenticator App
- **Action:** Select "Authenticator App"
- **Test ID:** `setup-2fa__method-authenticator`
- **Expected:** QR code and secret key displayed

### Step 12: Scan QR Code
- **Action:** User scans QR code with authenticator app
- **Expected:** Authenticator app displays 6-digit code

### Step 13: Enter Verification Code
- **Action:** Type 6-digit code from authenticator app
- **Test ID:** `setup-2fa__code-input`
- **Expected:** Code accepted

### Step 14: Verify 2FA Setup
- **Action:** Click "Verify and Enable 2FA" button
- **Test ID:** `setup-2fa__verify-button`
- **Expected:**
  - 2FA verified successfully
  - Success message: "2FA enabled! Your account is ready pending approval."

### Step 15: View Approval Status
- **Action:** User is redirected to status page
- **Test ID:** `approval-status__container`
- **Expected:** Status page shows:
  - Status: Pending Approval
  - Message: "Your account is awaiting approval from an administrator."
  - Estimated time: 1-2 business days

### Step 16: Log Out
- **Action:** Click "Log Out" button
- **Test ID:** `nav__logout-button`
- **Expected:** User is logged out and redirected to login page

### Step 17: Attempt to Log In (Pending State)
- **Action:** Enter email and password, click "Log In"
- **Test IDs:**
  - `login__email-input`
  - `login__password-input`
  - `login__submit-button`
- **Expected:**
  - Login succeeds
  - User is redirected to approval status page
  - Message: "Your account is still pending approval."

### Step 18: Wait for Approval
- **Action:** Administrator (Alice Chen) approves the account
- **Expected:** User receives email notification:
  - Subject: Your Account Has Been Approved - Firefighter Station
  - Message: Your account is now active

### Step 19: Log In After Approval
- **Action:** Enter email, password, and 2FA code
- **Test IDs:**
  - `login__email-input`
  - `login__password-input`
  - `login__2fa-input`
  - `login__submit-button`
- **Expected:**
  - Login succeeds
  - User is redirected to dashboard
  - First-time user onboarding flow may start

### Step 20: Complete Profile (Optional)
- **Action:** If prompted, complete profile setup
- **Test ID:** `profile-setup__container`
- **Expected:** User can:
  - Upload profile picture
  - Set display name preferences
  - Configure notification preferences

## Postconditions
- User account is created
- Email is verified
- 2FA is set up
- Account is pending approval
- User can check approval status
- After approval, user can log in and access assigned systems

## Test Assertions
- [ ] New user can navigate to signup page
- [ ] Personal information can be entered
- [ ] Affiliation can be selected
- [ ] Password can be set
- [ ] Terms can be accepted
- [ ] Registration can be submitted
- [ ] Form validation works
- [ ] Email verification is sent
- [ ] Verification link works
- [ ] 2FA setup is prompted
- [ ] Authenticator app can be selected
- [ ] QR code is displayed
- [ ] Verification code can be entered
- [ ] 2FA can be verified
- [ ] Approval status is visible
- [ ] User can log out
- [ ] Pending user can log in but sees status page
- [ ] Approval notification is sent
- [ ] After approval, user can log in fully
- [ ] 2FA is required for login
- [ ] Profile setup is available

## Error Cases
- **Email Already Exists:** Attempt to signup with existing email
  - **Expected:** Error message: "Email already registered. Use login or password reset."
- **Weak Password:** Password doesn't meet requirements
  - **Expected:** Validation error with requirements
- **Invalid Verification Link:** Expired or tampered link
  - **Expected:** Error message: "Invalid or expired verification link."
- **Invalid 2FA Code:** Wrong code entered
  - **Expected:** Error message, can retry
- **Missing Required Fields:** Attempt to submit without required fields
  - **Expected:** Validation errors for missing fields

## Performance Considerations
- Signup page should load within 500ms
- Form validation should be immediate
- Registration submission should complete within 1 second
- Email delivery should be within 1-2 minutes
- 2FA setup should complete within 30 seconds
- Login should complete within 500ms
