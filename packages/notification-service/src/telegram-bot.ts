import { Telegraf, type Context } from "telegraf";
import type { Telegram } from "telegraf";
import axios from "axios";

const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_URL ?? "http://orchestrator:3000";

export function createBot(token: string, adminChatId: string): { bot: Telegraf<Context>; adminChatId: string } {
  const bot = new Telegraf(token);

  bot.start((ctx) => {
    ctx.reply(
      "🤖 *CA-Bot Monitor*\n\nAvailable commands:\n" +
        "/status — System overview\n" +
        "/accounts — All accounts\n" +
        "/stats — Job capture stats\n" +
        "/pauseall — Pause all workers\n" +
        "/resumeall — Resume all workers",
      { parse_mode: "Markdown" }
    );
  });

  bot.command("status", async (ctx) => {
    try {
      const [workers, jobs] = await Promise.all([
        axios.get(`${ORCHESTRATOR_URL}/api/workers`),
        axios.get(`${ORCHESTRATOR_URL}/api/jobs?limit=5`),
      ]);
      const running = workers.data.running as string[];
      const recentJobs = jobs.data as Array<{ jobTitle?: string; location?: string; capturedAt: string }>;

      let msg = `📊 *System Status*\n\n`;
      msg += `Workers running: *${running.length}*\n`;
      msg += `\n*Recent Captures:*\n`;
      if (recentJobs.length === 0) {
        msg += "_None yet_";
      } else {
        recentJobs.forEach((j) => {
          const time = new Date(j.capturedAt).toLocaleTimeString("en-CA");
          msg += `• ${j.jobTitle ?? "Job"} — ${j.location ?? "?"} (${time})\n`;
        });
      }
      ctx.reply(msg, { parse_mode: "Markdown" });
    } catch (err) {
      ctx.reply("❌ Could not fetch status");
    }
  });

  bot.command("accounts", async (ctx) => {
    try {
      const resp = await axios.get(`${ORCHESTRATOR_URL}/api/accounts`);
      const accs = resp.data as Array<{ email: string; status: string; country: string }>;
      if (accs.length === 0) {
        ctx.reply("No accounts configured");
        return;
      }
      const emoji: Record<string, string> = {
        RUNNING: "🟢", POLLING: "🟢", IDLE: "⚪", PAUSED: "🟡",
        ERROR: "🔴", BANNED: "⛔", STARTING: "🔵",
      };
      const lines = accs.map((a) => `${emoji[a.status] ?? "⚪"} ${a.email} (${a.country}) — ${a.status}`);
      ctx.reply(`*Accounts (${accs.length})*\n\n` + lines.join("\n"), { parse_mode: "Markdown" });
    } catch {
      ctx.reply("❌ Could not fetch accounts");
    }
  });

  bot.command("stats", async (ctx) => {
    try {
      const resp = await axios.get(`${ORCHESTRATOR_URL}/api/jobs?limit=100`);
      const jobs = resp.data as Array<{ capturedAt: string; location?: string }>;
      const today = new Date().toDateString();
      const todayJobs = jobs.filter((j) => new Date(j.capturedAt).toDateString() === today);
      ctx.reply(
        `📈 *Stats*\n\nTotal captured: *${jobs.length}*\nToday: *${todayJobs.length}*`,
        { parse_mode: "Markdown" }
      );
    } catch {
      ctx.reply("❌ Could not fetch stats");
    }
  });

  bot.command("pauseall", async (ctx) => {
    try {
      const resp = await axios.get(`${ORCHESTRATOR_URL}/api/workers`);
      const running = resp.data.running as string[];
      await Promise.all(running.map((id) => axios.post(`${ORCHESTRATOR_URL}/api/workers/${id}/stop`)));
      ctx.reply(`⏸ Paused ${running.length} workers`);
    } catch {
      ctx.reply("❌ Could not pause workers");
    }
  });

  return { bot, adminChatId };
}

export async function sendAlert(bot: Telegraf<Context>, chatId: string, message: string) {
  try {
    await bot.telegram.sendMessage(chatId, message, { parse_mode: "Markdown" });
  } catch (err) {
    console.error("[Telegram] Failed to send message:", err);
  }
}
