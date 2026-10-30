# Persona 008: Auditor

## Overview
**Name:** Henry Lim  
**Role:** Auditor  
**Affiliation:** Audit  
**Email:** henry.lim@audit.gov.sg  

## Profile
- **Department:** Security Audit
- **Experience Level:** Senior (8+ years)
- **Technical Proficiency:** Advanced
- **Primary Responsibilities:** Review audit logs, verify compliance, generate reports
- **Access Level:** Read-only access to all logs and reports, no modification capabilities

## Goals
1. Review all system access and activities
2. Verify compliance with security policies
3. Generate audit reports
4. Identify suspicious activities
5. Maintain audit trail integrity

## Pain Points
- Needs comprehensive visibility
- Must identify anomalies quickly
- Requires detailed audit information
- Cannot modify any data (read-only)

## Typical Workflows
1. **Log Review:** Access and review all audit logs, access logs, and system events
2. **Compliance Checking:** Verify actions against security policies
3. **Anomaly Detection:** Identify suspicious patterns or activities
4. **Report Generation:** Create audit reports for compliance
5. **Investigation:** Trace specific events and user activities

## Technical Characteristics
- Uses password authentication with 2FA
- May have Entra ID SSO enabled
- Has read-only access to all logs
- Cannot modify any system data
- Can generate reports and exports

## Test Scenarios
- [ ] Can view all audit logs
- [ ] Can view all access logs
- [ ] Can view all system events
- [ ] Cannot modify any data
- [ ] Can generate reports
- [ ] Can export data
- [ ] Can filter and search logs

## Related Capabilities
- Audit log viewing
- Access log viewing
- Report generation
- Data export
- Anomaly detection
- Investigation support
