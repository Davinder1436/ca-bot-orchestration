import Redis from "ioredis";
import { OtpImapWatcher } from "./imap-client";

const REDIS_URL = process.env.REDIS_URL!;
if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
  console.error("[EmailService] GMAIL_USER and GMAIL_APP_PASSWORD are required");
  process.exit(1);
}

async function main() {
  const redis = new Redis(REDIS_URL);
  const watcher = new OtpImapWatcher(redis);

  process.on("SIGTERM", async () => {
    await watcher.stop();
    await redis.quit();
    process.exit(0);
  });

  console.log("[EmailService] Starting OTP email watcher");
  await watcher.start(); // loops forever with reconnect
}

main().catch((err) => { console.error(err); process.exit(1); });
