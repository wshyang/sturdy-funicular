// E2E: email direct-links, end to end, per notification trigger
// (plan_link_mapping.md / addendum-059).
//
// For each of the 16 request-related email triggers this suite:
//   1. drives a request into the state that fires that trigger (topology +
//      transitions via the real backend API, issued from the browser),
//   2. logs in as the SUPER ADMIN, opens the Sent Notifications outbox tab, and reads
//      the rendered <a href="…?dl=…"> straight out of that trigger's row —
//      asserting the outbox email really contains a valid direct link,
//   3. opens that link in a fresh recipient context (?dl=…), logs the recipient
//      in, clears the 2FA gate, and asserts they land directly on the
//      RequestDetailView for the right request.
//
// Uses the shared harness (screenshots + video built in).
import { test, expect } from '../helpers/harness';
import { E2E_USER_EMAIL, E2E_USER_PASSWORD } from '../global-setup';
import { login } from '../helpers/ui';
import {
  makeApiDriver, captureSession, extractDirectLinkForTrigger,
  assertValidDirectLink, followDirectLinkAsRecipient, type ApiDriver,
} from '../helpers/direct-link';

interface Actor { userId: string; email: string; password: string; fullName: string; }
interface World {
  adminDriver: ApiDriver;
  submitter: Actor; vendorL2: Actor; agencyL1: Actor; owner: Actor; paMember: Actor;
  systemId: string; systemName: string; assetId: string;
}

const RUN = Date.now().toString().slice(-6);
const PASSWORD = 'DirectLink!2026aa';

// Create a real, active user the recipient can later log in as: self-signup
// (sets their own password) + admin approval to a chosen affiliation. Signup
// doesn't echo an id, so we look it up via GET /admin/users by email.
async function signupAndApprove(
  adminDriver: ApiDriver,
  fullName: string,
  email: string,
  password: string,
  affiliation: 'agency' | 'vendor',
): Promise<string> {
  const su = await adminDriver.post('/auth/signup', { fullName, email, password });
  expect(su.status, `signup ${email} → ${JSON.stringify(su.json)}`).toBe(201);
  const userId = await lookupUserId(adminDriver, email);
  const ap = await adminDriver.post(`/admin/users/${userId}/approve`, { affiliation });
  expect(ap.status, `approve ${email} → ${JSON.stringify(ap.json)}`).toBe(200);
  return userId;
}

// GET /admin/users (via the driver's underlying page) and find the id by email.
async function lookupUserId(adminDriver: ApiDriver, email: string): Promise<string> {
  const res = await adminDriver.get('/admin/users');
  expect(res.status, `list users → ${JSON.stringify(res.json)}`).toBe(200);
  const found = (res.json.users as any[]).find((u) => u.email === email);
  if (!found) throw new Error(`user ${email} not found after signup`);
  return found.id as string;
}

test.describe('email direct-links — outbox to RequestDetailView, per trigger', () => {

  let world: World;

  test('every trigger carries a working direct link from the outbox to the request', async ({ page, browser }) => {
    await test.step('log in as super admin + build API driver', async () => {
      await login(page, E2E_USER_EMAIL, E2E_USER_PASSWORD);
      const session = await captureSession(page);
      const adminDriver = await makeApiDriver(page, session);
      world = {
        adminDriver,
        submitter: null as any, vendorL2: null as any, agencyL1: null as any,
        owner: null as any, paMember: null as any,
        systemId: '', systemName: `DL System ${RUN}`, assetId: '',
      };
    });

    await test.step('create actors via self-signup + admin approval', async () => {
      const d = world.adminDriver;
      const mk = async (label: string, aff: 'agency' | 'vendor'): Promise<Actor> => {
        const email = `dl-${label}-${RUN}@test.local`;
        const fullName = `DL ${label} ${RUN}`;
        const userId = await signupAndApprove(d, fullName, email, PASSWORD, aff);
        return { userId, email, password: PASSWORD, fullName };
      };
      world.submitter = await mk('submitter', 'vendor');
      world.vendorL2 = await mk('vendorl2', 'vendor');
      world.agencyL1 = await mk('agencyl1', 'agency');
      world.owner = await mk('owner', 'agency');
      world.paMember = await mk('pa', 'agency');
    });

    await test.step('create clusters, teams, system, memberships, owner, PA mapping, asset', async () => {
      const d = world.adminDriver;
      // Addendum-206 D2: every cluster must be anchored to a LIVE organisation
      // ("no NULL-org objects anywhere") — the server 400s an unanchored create
      // with "An organisation is required for every cluster." The shared UI
      // helper (helpers/scenario.ts) satisfies this by selecting
      // admin-clusters__org-select; this spec drives the API directly, so it
      // creates the anchor organisation itself and passes organizationId. A
      // vendor-typed cluster anchors to the agency org it serves, so a single
      // org anchors all three clusters here — matching what scenario.ts does.
      const orgRes = await d.post('/admin/organizations', {
        name: `DL Org ${RUN}`,
        shortCode: `DL${RUN}`.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10),
      });
      expect(orgRes.status, `create org → ${JSON.stringify(orgRes.json)}`).toBe(201);
      const organizationId = orgRes.json.organization.id as string;
      const cluster = async (name: string, type: 'vendor' | 'agency' | 'pa') => {
        const r = await d.post('/admin/clusters', { name: `${name} ${RUN}`, type, organizationId });
        expect(r.status, `cluster ${name} → ${JSON.stringify(r.json)}`).toBe(201);
        return r.json.cluster.id as string;
      };
      const vendorCluster = await cluster('Vendor', 'vendor');
      const agencyCluster = await cluster('Agency', 'agency');
      const paCluster = await cluster('PA', 'pa');

      const team = async (name: string, clusterId: string, level: number) => {
        const r = await d.post('/admin/teams', { name: `${name} ${RUN}`, clusterId: clusterId, level });
        expect(r.status, `team ${name} → ${JSON.stringify(r.json)}`).toBe(201);
        return r.json.team.id as string;
      };
      const vendorL1Team = await team('VendorL1', vendorCluster, 1);
      const vendorL2Team = await team('VendorL2', vendorCluster, 2);
      const agencyL1Team = await team('AgencyL1', agencyCluster, 1);
      const paTeam = await team('PATeam', paCluster, 1);

      const sysRes = await d.post('/admin/systems', {
        shortCode: `DL${RUN}`.slice(0, 10).toUpperCase(),
        name: world.systemName,
        primaryOwnerId: world.owner.userId,
        vendorClusterIds: [vendorCluster],
        agencyClusterId: agencyCluster,
        workflowDefinition: [
          { ordinal: 1, clusterId: vendorCluster, level: 1, stepKind: 'hierarchical', notes: null },
          { ordinal: 2, clusterId: vendorCluster, level: 2, stepKind: 'hierarchical', notes: null },
          { ordinal: 3, clusterId: agencyCluster, level: 1, stepKind: 'hierarchical', notes: null },
        ],
      });
      expect(sysRes.status, `system → ${JSON.stringify(sysRes.json)}`).toBe(201);
      world.systemId = sysRes.json.system.id;

      // Addendum-127: the create above auto-synced all three step teams'
      // mappings (workflow_definition ⋈ teams) — manual POSTs would 400
      // "already mapped".

      const addMember = async (teamId: string, userId: string) => {
        const r = await d.post(`/teams/${teamId}/members`, { userId: userId });
        expect(r.status, `member ${userId} → ${JSON.stringify(r.json)}`).toBe(201);
      };
      await addMember(vendorL1Team, world.submitter.userId);
      await addMember(vendorL2Team, world.vendorL2.userId);
      await addMember(agencyL1Team, world.agencyL1.userId);
      await addMember(paTeam, world.paMember.userId);

      // addendum-207 R6: owner-pa keys on the ownership row (system_owners.id),
      // exposed by the create-system response as primaryOwnerRowId.
      const paMap = await d.post('/admin/mappings/owner-pa', {
        systemOwnerId: sysRes.json.system.primaryOwnerRowId, paTeamId: paTeam,
      });
      expect(paMap.status, `pa-map → ${JSON.stringify(paMap.json)}`).toBe(201);

      const asset = await d.post(`/admin/systems/${world.systemId}/assets`, {
        hostname: `host-${RUN}`, credentialName: `svc-${RUN}`, managementMode: 'manual',
      });
      expect(asset.status, `asset → ${JSON.stringify(asset.json)}`).toBe(201);
      world.assetId = asset.json.asset.id;
    });

    const submissionBody = () => ({
      systemId: world.systemId,
      justification: 'Investigate a production incident requiring elevated access.',
      srNumber: `SR-${RUN}`,
      activityStartAt: new Date(Date.now() + 3_600_000).toISOString(),
      activityEndAt: new Date(Date.now() + 4 * 3_600_000).toISOString(),
      credentialItems: [{ assetId: world.assetId, hostnameDescription: 'test host' }],
    });

    async function driverFor(actor: Actor): Promise<{ driver: ApiDriver; close: () => Promise<void> }> {
      // Each actor gets an isolated context — the session token lives in
      // localStorage, so sharing one context would let actors clobber each
      // other's session.
      const ctx = await browser.newContext();
      const p = await ctx.newPage();
      await login(p, actor.email, actor.password);
      const session = await captureSession(p);
      const driver = await makeApiDriver(p, session);
      return { driver, close: () => ctx.close() };
    }

    async function submitAs(): Promise<{ id: string; number: string }> {
      const { driver, close } = await driverFor(world.submitter);
      try {
        const r = await driver.post('/requests', submissionBody());
        expect(r.status, `submit → ${JSON.stringify(r.json)}`).toBe(201);
        return { id: r.json.request.id, number: r.json.request.requestNumber };
      } finally { await close(); }
    }

    async function toOwnerTerminal(): Promise<{ id: string; number: string }> {
      const r = await submitAs();
      const v = await driverFor(world.vendorL2);
      try { await v.driver.post(`/requests/${r.id}/step-decision`, { decision: 'approve' }); } finally { await v.close(); }
      const a = await driverFor(world.agencyL1);
      try { await a.driver.post(`/requests/${r.id}/step-decision`, { decision: 'approve' }); } finally { await a.close(); }
      return r;
    }

    // (2) super-admin outbox assertion: the email for this trigger really
    // carries a valid direct link. Returns the link URL for optional follow-up.
    async function verifyOutboxLink(triggerKey: string): Promise<string> {
      const linkUrl = await extractDirectLinkForTrigger(page, triggerKey);
      assertValidDirectLink(linkUrl);
      return linkUrl;
    }

    // (2)+(3): outbox link AND the recipient can follow it to the request. Use
    // for recipients who CAN view the request (submitter, reviewers, owner).
    async function verifyTriggerLink(triggerKey: string, requestNumber: string, recipient: Actor) {
      const linkUrl = await verifyOutboxLink(triggerKey);
      const { page: recipientPage, close } = await followDirectLinkAsRecipient(browser, linkUrl, recipient.email, recipient.password);
      try {
        await expect(recipientPage.getByTestId('request-detail-view__back-button')).toBeVisible({ timeout: 30_000 });
        // The direct link opened THIS request: its number appears on the
        // detail view (more than once — title + body — so match the first).
        await expect(recipientPage.getByText(requestNumber).first()).toBeVisible();
      } finally { await close(); }
    }

    await test.step('submit → request.submitted + request.submitted_confirmation', async () => {
      const { number } = await submitAs();
      await verifyTriggerLink('request.submitted', number, world.vendorL2);
      await verifyTriggerLink('request.submitted_confirmation', number, world.submitter);
    });

    await test.step('step approve (→ next reviewer) → request.step_approved_next_reviewer', async () => {
      const { id, number } = await submitAs();
      const v = await driverFor(world.vendorL2);
      try { expect((await v.driver.post(`/requests/${id}/step-decision`, { decision: 'approve' })).status).toBe(200); } finally { await v.close(); }
      await verifyTriggerLink('request.step_approved_next_reviewer', number, world.agencyL1);
    });

    await test.step('step approve (final → owner) → request.step_approved_owner', async () => {
      const { id, number } = await submitAs();
      const v = await driverFor(world.vendorL2);
      try { await v.driver.post(`/requests/${id}/step-decision`, { decision: 'approve' }); } finally { await v.close(); }
      const a = await driverFor(world.agencyL1);
      try { expect((await a.driver.post(`/requests/${id}/step-decision`, { decision: 'approve' })).status).toBe(200); } finally { await a.close(); }
      await verifyTriggerLink('request.step_approved_owner', number, world.owner);
    });

    await test.step('step return → request.step_returned', async () => {
      const { id, number } = await submitAs();
      const v = await driverFor(world.vendorL2);
      try { expect((await v.driver.post(`/requests/${id}/step-decision`, { decision: 'return', notes: 'Add detail.' })).status).toBe(200); } finally { await v.close(); }
      await verifyTriggerLink('request.step_returned', number, world.submitter);
    });

    await test.step('step reject → request.step_rejected', async () => {
      const { id, number } = await submitAs();
      const v = await driverFor(world.vendorL2);
      try { expect((await v.driver.post(`/requests/${id}/step-decision`, { decision: 'reject', notes: 'Denied.' })).status).toBe(200); } finally { await v.close(); }
      await verifyTriggerLink('request.step_rejected', number, world.submitter);
    });

    await test.step('resubmit → request.resubmitted_step2', async () => {
      const { id, number } = await submitAs();
      const v = await driverFor(world.vendorL2);
      try { await v.driver.post(`/requests/${id}/step-decision`, { decision: 'return', notes: 'Fix.' }); } finally { await v.close(); }
      const s = await driverFor(world.submitter);
      try { expect((await s.driver.put(`/requests/${id}/resubmit`, submissionBody())).status).toBe(200); } finally { await s.close(); }
      await verifyTriggerLink('request.resubmitted_step2', number, world.vendorL2);
    });

    await test.step('owner approve → agency_l1 + submitter + pa_team', async () => {
      const { id, number } = await toOwnerTerminal();
      const o = await driverFor(world.owner);
      try { expect((await o.driver.post(`/requests/${id}/owner-decision`, { decision: 'approve' })).status).toBe(200); } finally { await o.close(); }
      await verifyTriggerLink('request.owner_approved_agency_l1', number, world.agencyL1);
      await verifyTriggerLink('request.owner_approved_submitter', number, world.submitter);
      // PA-team members receive the notification but are NOT request-visible
      // (canViewRequest is system-scoped; a PA team is linked to the owner, not
      // mapped to the system), so the link correctly resolves to a generic 404
      // for them. Assert only that the outbox email carries a valid link.
      await verifyOutboxLink('request.owner_approved_pa_team');
    });

    await test.step('owner return → request.owner_returned', async () => {
      const { id, number } = await toOwnerTerminal();
      const o = await driverFor(world.owner);
      try { expect((await o.driver.post(`/requests/${id}/owner-decision`, { decision: 'return', notes: 'More context.' })).status).toBe(200); } finally { await o.close(); }
      await verifyTriggerLink('request.owner_returned', number, world.submitter);
    });

    await test.step('owner reject → request.owner_rejected', async () => {
      const { id, number } = await toOwnerTerminal();
      const o = await driverFor(world.owner);
      try { expect((await o.driver.post(`/requests/${id}/owner-decision`, { decision: 'reject', notes: 'No.' })).status).toBe(200); } finally { await o.close(); }
      await verifyTriggerLink('request.owner_rejected', number, world.submitter);
    });

    await test.step('issue credential → request.credential_issued', async () => {
      const { id, number } = await toOwnerTerminal();
      const o = await driverFor(world.owner);
      try { await o.driver.post(`/requests/${id}/owner-decision`, { decision: 'approve' }); } finally { await o.close(); }
      const a = await driverFor(world.agencyL1);
      try { expect((await a.driver.post(`/requests/${id}/issue-credential`, {})).status).toBe(200); } finally { await a.close(); }
      await verifyTriggerLink('request.credential_issued', number, world.submitter);
    });

    await test.step('close → request.closed_submitter + request.closed_system_owner', async () => {
      const { id, number } = await toOwnerTerminal();
      const o = await driverFor(world.owner);
      try { await o.driver.post(`/requests/${id}/owner-decision`, { decision: 'approve' }); } finally { await o.close(); }
      const a = await driverFor(world.agencyL1);
      try {
        await a.driver.post(`/requests/${id}/issue-credential`, {});
        expect((await a.driver.post(`/requests/${id}/close`, { closingNotes: 'Done.' })).status).toBe(200);
      } finally { await a.close(); }
      await verifyTriggerLink('request.closed_submitter', number, world.submitter);
      await verifyTriggerLink('request.closed_system_owner', number, world.owner);
    });

    await test.step('admin reset → request.admin_reset', async () => {
      const { id, number } = await toOwnerTerminal();
      expect((await world.adminDriver.post(`/requests/${id}/admin-reset`, { notes: 'Reset.' })).status).toBe(200);
      await verifyTriggerLink('request.admin_reset', number, world.submitter);
    });
  });
});
