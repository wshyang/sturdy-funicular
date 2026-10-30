// Q11 opt-in daily "my pending actions" digest (assessment
// docs/assessments/physical-custody design §13.7;
// addendum-131; migrations/064+065).
//
// Matrix:
//   1. routes: GET default false; PUT {} ⇒ 400; PUT {optIn:true} ⇒ 200 and
//      the users row flips (self-service only — no admin override route).
//   2. an opted-in user WHO OWES an action gets exactly one digest envelope —
//      content pins: request number, the derivation's own cue label, the
//      per-request direct link; marker stamped.
//   3. immediate re-run ⇒ NO second envelope (last-sent marker covers
//      today's timing).
//   4. an opted-in user owing NOTHING stays silent (digest with zero owed
//      actions is noise).
//   5. schedule-anchored due-ness (addendum-197): a marker predating
//      TODAY's send instant ⇒ due again (even one stamped late YESTERDAY,
//      inside what the retired 20h rolling window would still suppress); a
//      marker at/after today's send instant ⇒ not due, however fresh/stale.
//   6. a tombstoned user is excluded even with a backdated marker
//      (active-only candidate set — nobody's recurring mail outlives them).
//   7. addendum-195: GET /health prompt — the fire-and-forget prompter
//      (maybeTriggerPendingActionsDigest, pending-actions/digest.tsx) reaches
//      the SAME guarded executor the cron registration uses, so a revived
//      (un-tombstoned) candidate whose marker predates today's send instant
//      receives their digest after nothing but a health probe + a bounded
//      poll. This is the backend half of the Playwright suite's
//      enable-toggle → digest-fire → outbox-row e2e
//      (regression/pending-actions-digest.spec.ts), and it pins that /health
//      prompting NEVER leaks abortive-tick spam: with the marker re-stamped
//      for today's timing, a second poll-window full of probes produces no
//      fifth envelope.
//
// Addendum-197 changed the ONE-mail-per-day mechanism: the retired 20h
// rolling throttle (DIGEST_THROTTLE_MS) is replaced by an anchor computed
// from the app_settings send TIME (a strictly-daily "m h * * *" schedule):
// due ⇔ now ≥ today's send instant AND marker < today's send instant. This
// suite pins the schedule row to 00:00 UTC (restored in step 8) so the
// matrix is time-of-day independent.
//
// Runs on the OWNER's machine (deno suites are not executed in-sandbox).
import { assert, assertEquals } from "jsr:@std/assert";
import {
  req, authHeaders, wipeDatabase, createAdmin, createActiveUser, loginAs,
  uniqueEmail, createWiredSystem, addMember, addServingMember, createAsset,
} from "./helpers.tsx";
import { query } from "../../../server/pg.tsx";
import {
  sendPendingActionsDailyDigests,
  digestTodaysSendAt,
  DIGEST_SCHEDULE_SETTING_KEY,
} from "../../../server/pending-actions/digest.tsx";
import { setSetting } from "../../../server/app-settings.tsx";

// Addendum-197 due-ness is anchored to the app-settings send TIME. The suite
// pins that setting to midnight-UTC (already past for any wall-clock run
// outside the first second of a UTC day) so every step is time-of-day
// independent, and restores the original row afterwards (app_settings rows
// outlive wipeDatabase — see helpers.tsx). All "backdates" below anchor to
// the pinned schedule's send instant, not to a rolling window.
const PINNED_DIGEST_SCHEDULE = "0 0 * * *";
const todaysSendAtIso = () => digestTodaysSendAt(new Date().toISOString(), PINNED_DIGEST_SCHEDULE)!;
const msBeforeTodaysSend = (ms: number) => new Date(Date.parse(todaysSendAtIso()) - ms).toISOString();
const msAfterTodaysSend = (ms: number) => new Date(Date.parse(todaysSendAtIso()) + ms).toISOString();

async function digestRows(recipientEmail: string) {
  const r = await query(
    `SELECT string_agg(ser.email_snapshot, ',') AS recipients, se.rendered_subject AS subject, se.rendered_body_html AS body FROM sent_notifications se JOIN notification_recipients ser ON ser.notification_id=se.id
     WHERE se.trigger_key = 'pending_actions.daily_digest' GROUP BY se.id ORDER BY se.created_at, se.id`,
    [],
  );
  return (r as Array<{ recipients: string; subject: string; body: string }>)
    .filter((row) => row.recipients.includes(recipientEmail));
}

Deno.test("Q11 pending-actions daily digest (addendum-131)", async (t) => {
  let requestNumber = "";
  let vendorApprover: { id: string; email: string };
  let vendorApproverSession = "";
  let adminId = "";
  let originalSchedule = "";

  await t.step("setup: wired system + an open request the vendor approver must review", async () => {
    await wipeDatabase();
    const admin = await createAdmin("DigAdmin!2026");
    adminId = admin.id;
    // Pin the daily send time to midnight-UTC for the whole suite (see the
    // file header); the seed row's original value is restored in the last
    // step so no state leaks into a later file of the same process.
    originalSchedule = ((await query(`SELECT value FROM app_settings WHERE key = $1`, [DIGEST_SCHEDULE_SETTING_KEY]))[0] as Record<string, unknown> | undefined)?.value as string ?? "15 0 * * *";
    await setSetting(DIGEST_SCHEDULE_SETTING_KEY, PINNED_DIGEST_SCHEDULE);
    const owner = await createActiveUser({ fullName: "Owner", email: uniqueEmail("digowner"), password: "OwnerPass!2026", affiliation: "agency" });
    const wired = await createWiredSystem(adminId, owner);
    const submitter = await createActiveUser({ fullName: "Submitter", email: uniqueEmail("digsub"), password: "SubmitPass!2026", affiliation: "vendor" });
    await addServingMember(wired.vendorL1, submitter, adminId);
    vendorApprover = await createActiveUser({ fullName: "VendorApprover", email: uniqueEmail("digvappr"), password: "VendorApprPass!2026", affiliation: "vendor" });
    await addServingMember(wired.vendorL2, vendorApprover, adminId);
    const submitterSession = ((await loginAs(submitter.email, "SubmitPass!2026")) as any).session;
    vendorApproverSession = ((await loginAs(vendorApprover.email, "VendorApprPass!2026")) as any).session;

    const asset = await createAsset(wired.system.id, { hostname: "dig-1", credentialName: "dig-cred" });
    const submitRes = await req("/requests", {
      method: "POST", headers: authHeaders(submitterSession),
      body: {
        systemId: wired.system.id, justification: "Digest coverage.", srNumber: "SR-9200",
        activityStartAt: new Date(Date.now() + 3_600_000).toISOString(),
        activityEndAt: new Date(Date.now() + 4 * 3_600_000).toISOString(),
        credentialItems: [{ assetId: asset.id }],
      },
    });
    assertEquals(submitRes.status, 201);
    const request = (await submitRes.json()).request;
    requestNumber = request.requestNumber;
  });

  await t.step("1) routes: GET default false; PUT {} ⇒ 400; PUT true persists", async () => {
    const getRes = await req("/me/pending-actions-digest", { headers: authHeaders(vendorApproverSession) });
    assertEquals(getRes.status, 200);
    assertEquals((await getRes.json()).optIn, false, 'digest is opt-IN — default false');

    const bad = await req("/me/pending-actions-digest", {
      method: "PUT", headers: authHeaders(vendorApproverSession), body: {},
    });
    assertEquals(bad.status, 400, 'optIn-less body rejected by the wire validator');

    const putRes = await req("/me/pending-actions-digest", {
      method: "PUT", headers: authHeaders(vendorApproverSession), body: { optIn: true },
    });
    assertEquals(putRes.status, 200);
    const col = await query(`SELECT pending_actions_digest_opt_in AS on FROM users WHERE id = $1`, [vendorApprover!.id]);
    assertEquals((col[0] as Record<string, unknown>).on, true, 'flag persisted on the users row');
  });

  await t.step("2) owing the review + opted in ⇒ exactly one digest, marker stamped", async () => {
    await sendPendingActionsDailyDigests();
    const rows = await digestRows(vendorApprover!.email);
    assertEquals(rows.length, 1, 'one mail for the opted-in owing user');
    assert(rows[0].body.includes(requestNumber), 'digest names the request number');
    assert(rows[0].body.includes('Review step'), 'digest reuses the derivation\'s own cue vocabulary');
    assert(rows[0].body.includes('>open</a>'), 'digest carries the per-request direct link');
    assert(rows[0].body.includes('1') && rows[0].subject.includes('1 pending action'), 'count rendered');
    const marker = await query(`SELECT pending_actions_digest_last_sent_at AS sent FROM users WHERE id = $1`, [vendorApprover!.id]);
    assert((marker[0] as Record<string, unknown>).sent != null, 'throttle marker stamped after fan-out');
    // The submitter owes nothing here and is not opted in — double silence.
    const all = await query(`SELECT count(*)::int AS n FROM sent_notifications WHERE trigger_key = 'pending_actions.daily_digest'`, []);
    assertEquals((all[0] as Record<string, unknown>).n, 1, 'exactly one envelope system-wide');
  });

  await t.step("3) immediate re-run ⇒ no second envelope (marker covers today's timing)", async () => {
    await sendPendingActionsDailyDigests();
    assertEquals((await digestRows(vendorApprover!.email)).length, 1, 'one mail per daily timing — the marker holds');
  });

  await t.step("4) opted-in but owing NOTHING ⇒ stays silent", async () => {
    // Opt the ADMIN in directly at the row (their session is not needed for a
    // pure candidate-set assertion); they hold no duties anywhere.
    await query(`UPDATE users SET pending_actions_digest_opt_in = true, pending_actions_digest_last_sent_at = NULL WHERE id = $1`, [adminId]);
    await sendPendingActionsDailyDigests();
    const admins = await query(`SELECT email FROM users WHERE id = $1`, [adminId]);
    const adminEmail = (admins[0] as Record<string, unknown>).email as string;
    assertEquals((await digestRows(adminEmail)).length, 0, 'an empty derivation never mails');
    const marker = await query(`SELECT pending_actions_digest_last_sent_at AS sent FROM users WHERE id = $1`, [adminId]);
    assertEquals((marker[0] as Record<string, unknown>).sent, null, 'no mail ⇒ no marker (NOT stamped for silence)');
  });

  await t.step("5) addendum-197: the marker is judged against TODAY'S send instant, not a rolling window", async () => {
    // 5a) marker 1 minute BEFORE today's send time ⇒ yesterday's timing ⇒ due.
    await query(`UPDATE users SET pending_actions_digest_last_sent_at = $1 WHERE id = $2`, [msBeforeTodaysSend(60_000), vendorApprover!.id]);
    await sendPendingActionsDailyDigests();
    assertEquals((await digestRows(vendorApprover!.email)).length, 2, 'predating today\'s send instant ⇒ the daily mail lands again');

    // 5b) marker 1 minute AFTER today's send time ⇒ today's timing covered ⇒
    // silent, no matter that the stamp is (wall-clock) almost a day old.
    await query(`UPDATE users SET pending_actions_digest_last_sent_at = $1 WHERE id = $2`, [msAfterTodaysSend(60_000), vendorApprover!.id]);
    await sendPendingActionsDailyDigests();
    assertEquals((await digestRows(vendorApprover!.email)).length, 2, 'a marker covering today\'s timing suppresses the rest of the day');

    // 5c) marker late YESTERDAY evening (send time − 1h) — the retired 20h
    // rolling window would still suppress this for most of a morning; the
    // schedule anchor correctly sees it as yesterday's timing ⇒ due.
    await query(`UPDATE users SET pending_actions_digest_last_sent_at = $1 WHERE id = $2`, [msBeforeTodaysSend(3_600_000), vendorApprover!.id]);
    await sendPendingActionsDailyDigests();
    assertEquals((await digestRows(vendorApprover!.email)).length, 3, 'late-yesterday stamps no longer drift today\'s send later');
  });

  await t.step("6) tombstoned user excluded even with a pre-send marker", async () => {
    await query(`UPDATE users SET status = 'tombstoned', pending_actions_digest_last_sent_at = $1 WHERE id = $2`, [msBeforeTodaysSend(60_000), vendorApprover!.id]);
    await sendPendingActionsDailyDigests();
    assertEquals((await digestRows(vendorApprover!.email)).length, 3, 'recurring mail does not outlive the account');
  });

  await t.step("7)/health prompt reaches the SAME guarded executor the cron uses (addendum-195)", async () => {
    // Revive the candidate (tombstoned in step 6) and set the marker just
    // before today's send instant so exactly one digest is due; then drive
    // NOTHING but health probes — the fire-and-forget prompter must run the
    // job itself.
    await query(`UPDATE users SET status = 'active', pending_actions_digest_last_sent_at = $1 WHERE id = $2`, [msBeforeTodaysSend(60_000), vendorApprover!.id]);

    // Wait out the prompt-side min interval: another Deno suite may have hit
    // /health moments earlier in this same process (the prompter's throttle
    // is per-process state, not per-test).
    await new Promise((resolve) => setTimeout(resolve, 5500));

    let sent = 0;
    for (let attempt = 0; attempt < 40; attempt++) {
      const health = await req("/health");
      assertEquals(health.status, 200, 'health probe always responds, prompt or not');
      await new Promise((resolve) => setTimeout(resolve, 500));
      sent = (await digestRows(vendorApprover!.email)).length;
      if (sent === 4) break;
    }
    assertEquals(sent, 4, 'a bare /health poll fires the digest for the due candidate');

    // Marker re-stamped by the prompted run (now covering today's timing) ⇒
    // a whole window of further probes must produce no fifth envelope (the
    // schedule anchor, not probe cadence, owns send decisions).
    for (let attempt = 0; attempt < 4; attempt++) {
      await req("/health");
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assertEquals((await digestRows(vendorApprover!.email)).length, 4, 'prompt storms stay silent once the marker covers today\'s timing');
  });

  await t.step("8) restore the pinned schedule setting (rows outlive wipeDatabase)", async () => {
    await setSetting(DIGEST_SCHEDULE_SETTING_KEY, originalSchedule);
    const row = (await query(`SELECT value FROM app_settings WHERE key = $1`, [DIGEST_SCHEDULE_SETTING_KEY]))[0] as Record<string, unknown>;
    assertEquals(row.value, originalSchedule, 'seed/derived schedule restored for the next suite in this process');
  });
});
