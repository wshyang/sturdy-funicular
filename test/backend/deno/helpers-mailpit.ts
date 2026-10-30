// Thin client for the Mailpit REST API (docker-compose `mailpit` service). The
// email-delivery tests point the app's smtp_* settings at Mailpit's SMTP port
// (127.0.0.1:1025, no auth) and then use these helpers to assert what was
// actually delivered via the REST API on :8025. See addendum-085 and the
// `mailpit` service in docker-compose.yml.
export const MAILPIT_API = Deno.env.get("MAILPIT_API") ?? "http://127.0.0.1:8025";

export interface MailpitAddress {
  Name: string;
  Address: string;
}

export interface MailpitSummary {
  ID: string;
  From: MailpitAddress;
  To: MailpitAddress[];
  Subject: string;
}

export interface MailpitList {
  total: number;
  messages_count: number;
  messages: MailpitSummary[];
}

export interface MailpitMessage {
  ID: string;
  From: MailpitAddress;
  To: MailpitAddress[];
  Subject: string;
  HTML: string;
  Text: string;
}

// Deletes every captured message so a test asserts only its own sends.
export async function mailpitClear(): Promise<void> {
  const res = await fetch(`${MAILPIT_API}/api/v1/messages`, { method: "DELETE" });
  // Drain the body so Deno doesn't leak the response resource.
  await res.body?.cancel();
}

// Lists captured messages (newest first), most-recent page.
export async function mailpitMessages(): Promise<MailpitList> {
  const res = await fetch(`${MAILPIT_API}/api/v1/messages`);
  return await res.json() as MailpitList;
}

// Fetches one message's full content (headers + HTML/Text body) by ID.
export async function mailpitMessage(id: string): Promise<MailpitMessage> {
  const res = await fetch(`${MAILPIT_API}/api/v1/message/${id}`);
  return await res.json() as MailpitMessage;
}

// Polls until Mailpit reports at least `n` captured messages, or returns the
// last observed list after the timeout. SMTP delivery is async relative to the
// send call returning, so a bare read can race; this makes it deterministic.
export async function mailpitWaitFor(n: number, timeoutMs = 5000): Promise<MailpitList> {
  const deadline = Date.now() + timeoutMs;
  let last: MailpitList = { total: 0, messages_count: 0, messages: [] };
  while (Date.now() < deadline) {
    last = await mailpitMessages();
    if (last.messages_count >= n) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  return last;
}
