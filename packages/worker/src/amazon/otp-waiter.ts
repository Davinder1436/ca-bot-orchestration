import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";

const OTP_TIMEOUT_MS = 120_000;
const POLL_INTERVAL  =   5_000;

// OTP patterns — most specific first.
// Amazon Jobs format: "This is your verification code for Amazon Jobs: 639449"
const OTP_PATTERNS = [
  /Amazon Jobs[:\s]+(\d{6})/i,
  /verification code[:\s]+(\d{6})/i,
  /code\b[^:\n]{0,40}:\s*(\d{6})/i,
  /\b(\d{6})\b(?=\s*(?:is your|verification|code|PIN))/i,
  /your code is[:\s]+(\d{6})/i,
  /\b(\d{6})\b/,
];

function extractOtp(text: string): string | null {
  for (const p of OTP_PATTERNS) {
    const m = text.match(p);
    if (m?.[1]) return m[1];
  }
  return null;
}

// Polls Gmail IMAP every POLL_INTERVAL ms looking for a NEW Amazon OTP email.
// "New" means: delivered AFTER this function was called — avoids reusing codes
// from earlier login attempts in the same session.
export async function waitForOtp(accountEmail: string, _accountId: string): Promise<string> {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) throw new Error("GMAIL_USER / GMAIL_APP_PASSWORD not set");

  // Grace window: accept emails delivered up to 10s before this call
  // (covers slight clock drift between Amazon's server and our wall clock).
  const requestedAt = new Date(Date.now() - 10_000);

  console.log(`[OTP:${accountEmail}] Polling Gmail IMAP every ${POLL_INTERVAL / 1000}s (timeout ${OTP_TIMEOUT_MS / 1000}s, cutoff ${requestedAt.toISOString()})`);

  const deadline = Date.now() + OTP_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const result = await fetchFreshestOtp(user, pass, requestedAt);
    if (result) {
      console.log(`[OTP:${accountEmail}] Got code → ${result.otp} (email date: ${result.date.toISOString()})`);
      return result.otp;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(POLL_INTERVAL, remaining));
  }

  throw new Error(`OTP timeout for ${accountEmail} after ${OTP_TIMEOUT_MS / 1000}s`);
}

async function fetchFreshestOtp(
  user: string,
  pass: string,
  since: Date,
): Promise<{ otp: string; date: Date } | null> {
  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user, pass },
    logger: false,
  });

  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    try {
      // IMAP SINCE is date-only (no time), so we anchor to yesterday to ensure
      // we capture all of today's messages. We filter by exact time below.
      const imapSince = new Date(since);
      imapSince.setDate(imapSince.getDate() - 1);
      imapSince.setHours(0, 0, 0, 0);

      const uids = await client.search(
        { since: imapSince, from: "amazon" },
        { uid: true },
      ) as number[];
      if (!uids.length) return null;

      const candidates: { date: Date; otp: string }[] = [];

      for await (const msg of client.fetch(uids, { source: true }, { uid: true })) {
        if (!msg.source) continue;
        const parsed = await simpleParser(msg.source);

        // Precise time filter — skip emails older than our cutoff
        const msgDate = parsed.date ?? new Date(0);
        if (msgDate < since) continue;

        const subject = parsed.subject?.toLowerCase() ?? "";
        const from    = parsed.from?.text?.toLowerCase() ?? "";
        if (!subject.includes("verification") &&
            !subject.includes("code") &&
            !from.includes("amazon")) continue;

        const otp = extractOtp(parsed.text ?? "");
        if (otp) candidates.push({ date: msgDate, otp });
      }

      if (candidates.length === 0) return null;

      // Always pick the most recently delivered code
      candidates.sort((a, b) => b.date.getTime() - a.date.getTime());

      if (candidates.length > 1) {
        console.log(
          `[OTP] ${candidates.length} fresh codes found; using newest: ${candidates[0].otp}` +
          ` (${candidates[0].date.toISOString()}). Others: ${candidates.slice(1).map(c => c.otp).join(", ")}`,
        );
      }

      return candidates[0];
    } finally {
      lock.release();
    }
  } catch (err) {
    console.warn(`[OTP] IMAP poll error: ${err instanceof Error ? err.message : err}`);
  } finally {
    await client.logout().catch(() => {});
  }
  return null;
}

function sleep(ms: number) { return new Promise<void>(r => setTimeout(r, ms)); }
