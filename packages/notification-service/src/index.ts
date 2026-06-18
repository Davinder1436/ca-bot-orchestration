import Redis from "ioredis";
import { createBot, sendAlert } from "./telegram-bot";

const REDIS_URL = process.env.REDIS_URL!;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID!;

if (!BOT_TOKEN || !ADMIN_CHAT_ID) {
  console.error("[Notifications] TELEGRAM_BOT_TOKEN and TELEGRAM_ADMIN_CHAT_ID required");
  process.exit(1);
}

type EventPayload = Record<string, string | number | boolean | undefined>;

function formatEvent(type: string, payload: EventPayload): string | null {
  const email = payload.email ?? payload.accountId ?? "unknown";

  switch (type) {
    case "job:captured":
      return (
        `✅ *Job Captured!*\n` +
        `Account: \`${email}\`\n` +
        `Job: ${payload.jobTitle ?? "N/A"}\n` +
        `Location: ${payload.location ?? "N/A"}\n` +
        `Slots: ${payload.slotsAvailable ?? "?"}\n` +
        `Shift: ${payload.shiftTime ?? "N/A"}\n` +
        `[Open Application](${payload.applyUrl})`
      );

    case "session:expired":
      return `⚠️ *Session Expired*\nAccount: \`${email}\`\nRe-login will be attempted automatically.`;

    case "worker:crashed":
      return `❌ *Worker Crashed*\nAccount: \`${email}\`\nReason: ${payload.reason ?? "unknown"}`;

    case "proxy:failed":
      return `🔄 *Proxy Failed*\nAccount: \`${email}\`\nProxy: ${payload.proxyUrl ?? "?"}\nReassigning...`;

    case "account:banned":
      return `🚫 *Account Possibly Banned*\nAccount: \`${email}\`\nPausing this worker.`;

    case "account:possible_shadow_ban":
      return `👻 *Possible Shadow Ban*\nAccount: \`${email}\`\n${payload.consecutiveEmpty} consecutive empty polls.`;

    case "job:application_confirmed":
      return `🎉 *Application Confirmed!*\nAccount: \`${email}\`\nSchedule: ${payload.scheduleId}`;

    case "daily:summary":
      return `📊 *Daily Summary*\nJobs captured: ${payload.total ?? 0}\nActive accounts: ${payload.activeAccounts ?? 0}`;

    default:
      return null; // Don't notify for every event type
  }
}

async function main() {
  const redis = new Redis(REDIS_URL);
  const { bot, adminChatId } = createBot(BOT_TOKEN, ADMIN_CHAT_ID);

  // Subscribe to all events
  const sub = redis.duplicate();
  await sub.subscribe("event:*");

  sub.on("message", async (_channel, raw) => {
    try {
      const event = JSON.parse(raw) as { type: string; payload: EventPayload };
      const message = formatEvent(event.type, event.payload);
      if (message) {
        await sendAlert(bot, adminChatId, message);
      }
    } catch (err) {
      console.error("[Notifications] Failed to process event:", err);
    }
  });

  // Daily summary cron (every day at 11:59 PM)
  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(23, 59, 0, 0);
  const msUntilMidnight = midnight.getTime() - now.getTime();
  setTimeout(async function sendDailySummary() {
    // Handled by a "daily:summary" event published by orchestrator
    setTimeout(sendDailySummary, 24 * 60 * 60 * 1000);
  }, msUntilMidnight);

  // Launch bot
  bot.launch();
  console.log("[Notifications] Telegram bot started, listening for events");

  process.on("SIGTERM", async () => {
    bot.stop("SIGTERM");
    await sub.quit();
    await redis.quit();
    process.exit(0);
  });
}

main().catch((err) => { console.error(err); process.exit(1); });
