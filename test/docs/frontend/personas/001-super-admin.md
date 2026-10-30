# Persona 001: Super Administrator

## Overview
**Name:** Alice Chen  
**Role:** Super Administrator  
**Affiliation:** Admin  
**Email:** alice.chen@firefighter-station.gov.sg  

## Profile
- **Department:** IT Security Operations
- **Experience Level:** Senior (8+ years)
- **Technical Proficiency:** Expert
- **Primary Responsibilities:** System-wide configuration, user management, audit oversight
- **Access Level:** Full access to all features and settings

## Goals
1. Maintain system security and integrity
2. Configure global settings and integrations
3. Audit all user activities and system events
4. Manage organization structure (clusters, teams, systems)
5. Oversee emergency access procedures

## Pain Points
- Needs to quickly identify and resolve security issues
- Must maintain audit trail for compliance
- Manages complex organization hierarchies
- Responsible for disaster recovery procedures

## Typical Workflows
1. **System Configuration:** Set up and modify global application settings
2. **User Management:** Approve/reject user signups, manage affiliations, tombstone users
3. **Audit Review:** Monitor access logs, audit trails, and system events
4. **Emergency Access:** Reset passwords, override approvals, manage break-glass scenarios
5. **Integration Management:** Configure AWS, Entra ID, Slack integrations

## Technical Characteristics
- Uses both password and Entra ID SSO authentication
- Requires 2FA for all sensitive operations
- Has `full_admin` role with all capabilities
- Can access all admin panels without restrictions

## Test Scenarios
- [ ] Can access all admin tabs
- [ ] Can perform all user management operations
- [ ] Can configure all system settings
- [ ] Can view all audit logs and access logs
- [ ] Can reset any request
- [ ] Can manage all integrations

## Related Capabilities
- All admin capabilities (full_admin role)
- All system visibility
- All team management
- All user management
