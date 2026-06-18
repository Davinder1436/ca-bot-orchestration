import Redis from "ioredis";
import { EventBus } from "./events/event-bus";
import { launchBrowser, createContext, pickUAIndex, USER_AGENTS, VIEWPORTS } from "./browser/launch";
import { login } from "./amazon/login";
import { JobPoller } from "./amazon/job-poller";
import { applyForJob } from "./amazon/apply";
import { solveCaptchaOnPage } from "./amazon/captcha";
import type { Browser, BrowserContext } from "playwright";
import axios from "axios";

const REDIS_URL = process.env.REDIS_URL!;
const ACCOUNT_ID = process.env.ACCOUNT_ID!;
const PROXY_URL = process.env.PROXY_URL;

if (!REDIS_URL || !ACCOUNT_ID) {
  console.error("[Worker] REDIS_URL and ACCOUNT_ID are required");
  process.exit(1);
}

type WorkerState =
  | "IDLE" | "STARTING" | "LOGGING_IN" | "WAITING_OTP"
  | "AUTHENTICATED" | "POLLING" | "JOB_FOUND"
  | "APPLYING" | "CAPTCHA_SOLVING" | "ERROR" | "STOPPED";

async function fetchAccountConfig() {
  const orchestratorUrl = process.env.ORCHESTRATOR_URL ?? "http://orchestrator:3000";
  const resp = await axios.get(`${orchestratorUrl}/api/accounts/${ACCOUNT_ID}`, { timeout: 10_000 });
  return resp.data as {
    id: string;
    email: string;
    pin: string;
    country: "CA" | "US";
    jobIds: string[];
    proxy?: { url: string };
  };
}

async function setState(bus: EventBus, state: WorkerState) {
  await bus.publish("worker:state", { accountId: ACCOUNT_ID, state });
  console.log(`[Worker:${ACCOUNT_ID}] State → ${state}`);
}

async function main() {
  const redis = new Redis(REDIS_URL);
  const bus = new EventBus(REDIS_URL);

  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let poller: JobPoller | null = null;
  let running = true;

  // Heartbeat every 30s
  const heartbeatInterval = setInterval(async () => {
    await bus.publish("worker:heartbeat", { accountId: ACCOUNT_ID });
  }, 30_000);

  const shutdown = async () => {
    running = false;
    clearInterval(heartbeatInterval);
    poller?.stop();
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await bus.disconnect();
    await redis.quit();
    console.log(`[Worker:${ACCOUNT_ID}] Shutdown complete`);
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  await setState(bus, "STARTING");

  // Fetch account config from orchestrator
  const account = await fetchAccountConfig();
  console.log(`[Worker:${ACCOUNT_ID}] Account: ${account.email}, Jobs: ${account.jobIds.join(", ")}`);

  const uaIndex = pickUAIndex(ACCOUNT_ID);
  const proxyUrl = PROXY_URL ?? account.proxy?.url;

  // Launch browser
  browser = await launchBrowser({ proxyUrl });
  context = await createContext(browser, {
    userAgent: USER_AGENTS[uaIndex],
    viewport: VIEWPORTS[uaIndex % VIEWPORTS.length],
    proxyUrl,
    timezone: account.country === "CA" ? "America/Toronto" : "America/New_York",
  });

  await setState(bus, "LOGGING_IN");

  let accessToken: string;
  try {
    accessToken = await login(context, {
      email: account.email,
      pin: account.pin,
      country: account.country,
      accountId: ACCOUNT_ID,
    });
  } catch (err) {
    console.error(`[Worker:${ACCOUNT_ID}] Login failed:`, err);
    await setState(bus, "ERROR");
    await bus.publish("worker:crashed", {
      accountId: ACCOUNT_ID,
      email: account.email,
      reason: String(err),
    });
    await shutdown();
    return;
  }

  await setState(bus, "POLLING");

  // Subscribe to job:captured events for THIS account to trigger apply
  const sub = redis.duplicate();
  await sub.subscribe(`event:job:captured`);
  sub.on("message", async (_channel, raw) => {
    try {
      const event = JSON.parse(raw);
      if (event.payload?.accountId !== ACCOUNT_ID) return;
      if (!running) return;

      const { applyUrl, email } = event.payload;
      await setState(bus, "APPLYING");
      const success = await applyForJob(context!, applyUrl, email);

      if (success) {
        await bus.publish("job:application_confirmed", {
          accountId: ACCOUNT_ID,
          email: account.email,
          applyUrl,
          scheduleId: event.payload.scheduleId,
        });
      }
      await setState(bus, "POLLING");
    } catch (err) {
      console.error(`[Worker:${ACCOUNT_ID}] Apply error:`, err);
    }
  });

  // Start polling
  poller = new JobPoller(
    {
      accountId: ACCOUNT_ID,
      email: account.email,
      country: account.country,
      jobIds: account.jobIds,
      accessToken,
      intervalMs: 5_000,
    },
    bus
  );

  // Handle session expiry: stop poller, re-login
  const sessionSub = redis.duplicate();
  await sessionSub.subscribe("event:session:expired");
  sessionSub.on("message", async (_ch, raw) => {
    const event = JSON.parse(raw);
    if (event.payload?.accountId !== ACCOUNT_ID) return;
    console.log(`[Worker:${ACCOUNT_ID}] Session expired — re-logging in`);
    poller?.stop();
    await setState(bus, "LOGGING_IN");
    try {
      const newToken = await login(context!, {
        email: account.email,
        pin: account.pin,
        country: account.country,
        accountId: ACCOUNT_ID,
      });
      poller!.updateToken(newToken);
      await setState(bus, "POLLING");
      poller!.start(); // restart
    } catch (err) {
      console.error(`[Worker:${ACCOUNT_ID}] Re-login failed:`, err);
      await setState(bus, "ERROR");
    }
  });

  await poller.start(); // blocks until stopped
  await shutdown();
}

main().catch(async (err) => {
  console.error("[Worker] Fatal:", err);
  process.exit(1);
});
