import { ImapFlow, type FetchMessageObject } from "imapflow";
import { simpleParser } from "mailparser";
import type Redis from "ioredis";
import { extractOtp, extractOriginalRecipient, isAmazonEmail } from "./otp-extractor";

const OTP_CHANNEL_PREFIX = "otp:";
const OTP_TTL_SECONDS = 120;

export class OtpImapWatcher {
  private stopped = false;

  constructor(private redis: Redis) {}

  async start() {
    while (!this.stopped) {
      try {
        await this.connect();
      } catch (err) {
        if (!this.stopped) {
          console.error("[EmailService] Connection error, reconnecting in 10s:", err);
          await sleep(10_000);
        }
      }
    }
  }

  private async connect() {
    const client = new ImapFlow({
      host: "imap.gmail.com",
      port: 993,
      secure: true,
      auth: {
        user: process.env.GMAIL_USER!,
        pass: process.env.GMAIL_APP_PASSWORD!,
      },
      logger: false,
    });

    await client.connect();
    console.log("[EmailService] Connected to Gmail IMAP");

    const lock = await client.getMailboxLock("INBOX");
    try {
      // Process any backlog of unseen emails first
      await this.processUnseen(client);

      // Listen for new messages via the 'exists' event
      client.on("exists", async (data: { count: number; prevCount: number }) => {
        // New messages arrived — fetch the latest ones
        const newCount = data.count - data.prevCount;
        if (newCount <= 0) return;
        const start = data.prevCount + 1;
        const end = data.count;
        await this.fetchRange(client, `${start}:${end}`);
      });

      console.log("[EmailService] Watching INBOX via IDLE");
      // Runs IDLE loop until connection drops
      await client.idle();
    } finally {
      lock.release();
      await client.logout().catch(() => {});
    }
  }

  private async processUnseen(client: ImapFlow) {
    const result = await client.search({ seen: false }, { uid: true });
    const uids: number[] = Array.isArray(result) ? result : [];
    if (uids.length === 0) return;
    // Only process last 10 to avoid flooding on startup
    const recent = uids.slice(-10);
    for await (const msg of client.fetch(recent, { source: true, envelope: true }, { uid: true })) {
      if (msg.source) await this.handleMessage(msg);
    }
  }

  private async fetchRange(client: ImapFlow, range: string) {
    try {
      for await (const msg of client.fetch(range, { source: true, envelope: true })) {
        if (msg.source) await this.handleMessage(msg);
      }
    } catch (err) {
      console.error("[EmailService] fetchRange error:", err);
    }
  }

  private async handleMessage(msg: FetchMessageObject) {
    if (!msg.source) return;
    try {
      const parsed = await simpleParser(msg.source);
      const fromText = parsed.from?.text ?? "";
      const subject = parsed.subject ?? "";

      if (!isAmazonEmail(fromText, subject)) return;

      const bodyText = parsed.text ?? "";

      const otp = extractOtp(bodyText);
      if (!otp) {
        console.log(`[EmailService] Amazon email but no OTP — From: ${fromText}, Subject: ${subject}`);
        return;
      }

      // Build headers map for recipient detection
      const headers: Record<string, string> = {};
      parsed.headers.forEach((val, key) => {
        headers[key] = Array.isArray(val) ? val.join(", ") : String(val);
      });

      const originalRecipient = extractOriginalRecipient(headers, bodyText);
      if (!originalRecipient) {
        console.warn("[EmailService] Cannot determine original recipient for OTP");
        return;
      }

      const channel = `${OTP_CHANNEL_PREFIX}${originalRecipient}`;
      console.log(`[EmailService] OTP for ${originalRecipient} → publishing to ${channel}`);

      await this.redis.set(channel, otp, "EX", OTP_TTL_SECONDS);
      await this.redis.publish(channel, otp);
    } catch (err) {
      console.error("[EmailService] Error processing message:", err);
    }
  }

  stop() {
    this.stopped = true;
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
