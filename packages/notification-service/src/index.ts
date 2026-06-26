import Redis from "ioredis";
import { createBot, sendAlert } from "./telegram-bot";

const REDIS_URL = process.env.REDIS_URL!;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID;

const telegramEnabled = !!(
  BOT_TOKEN &&
  ADMIN_CHAT_ID &&
  !BOT_TOKEN.includes("...") &&
  !BOT_TOKEN.startsWith("123456:")
);

if (!telegramEnabled) {
  console.log("[Notifications] Telegram disabled (no valid credentials) — logging to console only");
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

  let bot: ReturnType<typeof createBot>["bot"] | null = null;
  let adminChatId = "";

  if (telegramEnabled) {
    const created = createBot(BOT_TOKEN!, ADMIN_CHAT_ID!);
    bot = created.bot;
    adminChatId = created.adminChatId;
    bot.launch();
    console.log("[Notifications] Telegram bot started, listening for events");
  }

  const sub = redis.duplicate();
  await sub.subscribe("event:*");

  sub.on("message", async (_channel, raw) => {
    try {
      const event = JSON.parse(raw) as { type: string; payload: EventPayload };
      const message = formatEvent(event.type, event.payload);
      if (!message) return;

      if (telegramEnabled && bot) {
        await sendAlert(bot, adminChatId, message);
      } else {
        // Console-only fallback when Telegram is not configured
        console.log(`[Notifications] ${event.type}:`, message.replace(/[*`[\]()]/g, ""));
      }
    } catch (err) {
      console.error("[Notifications] Failed to process event:", err);
    }
  });

  process.on("SIGTERM", async () => {
    if (bot) bot.stop("SIGTERM");
    await sub.quit();
    await redis.quit();
    process.exit(0);
  });
}

main().catch((err) => { console.error(err); process.exit(1); });
