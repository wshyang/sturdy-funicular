# Persona 002: Agency L1 Team Lead

## Overview
**Name:** Benjamin Lee  
**Role:** Agency L1 Team Lead  
**Affiliation:** Agency  
**Email:** benjamin.lee@agency.gov.sg  

## Profile
- **Department:** Agency Operations - Level 1
- **Experience Level:** Mid-level (4-6 years)
- **Technical Proficiency:** Advanced
- **Primary Responsibilities:** Request review and approval for agency systems, team coordination
- **Access Level:** Can view and approve requests for assigned systems, manage team members

## Goals
1. Review and approve break-glass requests for agency systems
2. Coordinate with L2 teams for complex approvals
3. Manage team membership and roles
4. Monitor system health and access patterns
5. Escalate issues to appropriate stakeholders

## Pain Points
- Needs clear visibility into pending requests
- Must coordinate approvals across multiple systems
- Balances team management with operational duties
- Requires quick access to system information

## Typical Workflows
1. **Request Review:** View pending requests, review details, approve/reject based on policy
2. **Team Management:** Add/remove team members, assign roles
3. **System Monitoring:** Check system status, view recent access logs
4. **Escalation:** Forward complex requests to L2 teams
5. **Reporting:** Generate statistics on request volumes and approval times

## Technical Characteristics
- Primarily uses password authentication with 2FA
- May have Entra ID SSO enabled
- Has team_admin role for their assigned teams
- Can view systems they are mapped to
- Can approve requests for their assigned systems

## Test Scenarios
- [ ] Can view requests for assigned systems
- [ ] Can approve/reject requests
- [ ] Can manage team members
- [ ] Can view system information
- [ ] Cannot access admin-only features
- [ ] Cannot view requests for non-assigned systems

## Related Capabilities
- Request review and approval
- Team member management
- System information viewing
- Access to assigned systems only
