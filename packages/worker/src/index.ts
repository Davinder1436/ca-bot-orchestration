import Redis from "ioredis";
import http from "http";
import { EventBus } from "./events/event-bus";
import { launchBrowser, createContext, pickUAIndex, USER_AGENTS, VIEWPORTS } from "./browser/launch";
import { login } from "./amazon/login";
import { JobPoller } from "./amazon/job-poller";
import { RunLogger } from "./RunLogger";
import { applyForJob } from "./amazon/apply";
import { solveCaptchaOnPage } from "./amazon/captcha";
import type { Browser, BrowserContext, Page } from "playwright";
import axios from "axios";

// Test the ISP proxy by issuing an HTTP CONNECT request (exactly what Chrome does
// for HTTPS sites). Returns true only if the proxy accepts the tunnel.
async function testProxyConnect(host: string, port: number, user: string, pass: string, timeoutMs = 10_000): Promise<boolean> {
  return new Promise((resolve) => {
    const auth = Buffer.from(`${user}:${pass}`).toString("base64");
    const req = http.request({
      host,
      port,
      method: "CONNECT",
      path: "hiring.amazon.ca:443",
      headers: { "Proxy-Authorization": `Basic ${auth}`, "Host": "hiring.amazon.ca:443" },
      timeout: timeoutMs,
    });
    req.on("connect", (_res, socket) => { socket.destroy(); resolve(true); });
    req.on("timeout",  () => { req.destroy(); resolve(false); });
    req.on("error",    () => { req.destroy(); resolve(false); });
    req.end();
  });
}

const REDIS_URL = process.env.REDIS_URL!;
const ACCOUNT_ID = process.env.ACCOUNT_ID!;
const PROXY_URL = process.env.PROXY_URL;

// Bright Data ISP fixed-session proxy — each account gets a consistent exit IP
// via a session ID derived from its accountId prefix
const ISP_HOST = process.env.BRIGHTDATA_ISP_HOST;
const ISP_PORT = process.env.BRIGHTDATA_ISP_PORT;
const ISP_USER = process.env.BRIGHTDATA_ISP_USER;
const ISP_PASS = process.env.BRIGHTDATA_ISP_PASS;
const ispProxyUrl = (ISP_HOST && ISP_PORT && ISP_USER && ISP_PASS)
  ? `http://${ISP_USER}-session-${ACCOUNT_ID.slice(0, 8)}:${ISP_PASS}@${ISP_HOST}:${ISP_PORT}`
  : undefined;

// Bright Data DC rotating proxy — no session ID = new IP per request (40k pool)
const DC_HOST = process.env.BRIGHTDATA_DC_HOST;
const DC_PORT = process.env.BRIGHTDATA_DC_PORT;
const DC_USER = process.env.BRIGHTDATA_DC_USER;
const DC_PASS = process.env.BRIGHTDATA_DC_PASS;
const rotatingDcProxyUrl = (DC_HOST && DC_PORT && DC_USER && DC_PASS)
  ? `http://${DC_USER}:${DC_PASS}@${DC_HOST}:${DC_PORT}`
  : undefined;

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
  let activePage: Page | null = null;

  const runLogger = new RunLogger(redis, ACCOUNT_ID);

  // Heartbeat every 30s
  const heartbeatInterval = setInterval(async () => {
    await bus.publish("worker:heartbeat", { accountId: ACCOUNT_ID });
  }, 30_000);

  // Screenshot capture loop — stores latest JPEG in Redis for live debug view
  const screenshotInterval = setInterval(async () => {
    const page = activePage;
    if (!page || page.isClosed()) return;
    try {
      const buf = await page.screenshot({ type: "jpeg", quality: 60 });
      await redis.set(`worker:screenshot:${ACCOUNT_ID}`, buf.toString("base64"), "EX", 15);
    } catch { /* page may be navigating */ }
  }, 1500);

  let cmdSub: Redis | null = null;

  const shutdown = async (crashReason?: string) => {
    running = false;
    clearInterval(heartbeatInterval);
    clearInterval(screenshotInterval);
    poller?.stop();
    await runLogger.finalize(crashReason ? "crashed" : "stopped", crashReason).catch(() => {});
    await cmdSub?.quit().catch(() => {});
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

  // ISP proxy: verify the CONNECT tunnel before committing.
  // Chrome sends HTTP CONNECT to establish HTTPS tunnels through a proxy.
  // If the proxy hangs on CONNECT (common when auth isn't accepted pre-emptively),
  // every page.goto() will timeout — so we gate usage on a live CONNECT test.
  let proxyUrl = PROXY_URL ?? account.proxy?.url;
  if (ispProxyUrl && ISP_HOST && ISP_PORT && ISP_USER && ISP_PASS) {
    const fullUser = `${ISP_USER}-session-${ACCOUNT_ID.slice(0, 8)}`;
    console.log(`[Worker:${ACCOUNT_ID}] Testing ISP proxy ${ISP_HOST}:${ISP_PORT} (session: ${ACCOUNT_ID.slice(0, 8)})...`);
    const ok = await testProxyConnect(ISP_HOST, parseInt(ISP_PORT), fullUser, ISP_PASS);
    if (ok) {
      proxyUrl = ispProxyUrl;
      console.log(`[Worker:${ACCOUNT_ID}] ISP proxy OK — CONNECT tunnel accepted`);
    } else {
      console.warn(`[Worker:${ACCOUNT_ID}] ISP proxy CONNECT test failed (unreachable or auth rejected from this container) — falling back to direct/account proxy`);
    }
  }

  const uaIndex = pickUAIndex(ACCOUNT_ID);

  await runLogger.init({
    email: account.email,
    jobIds: account.jobIds,
    proxyUrl: proxyUrl ?? null,
  });
  await runLogger.log(
    `Worker started — email=${account.email} jobs=${account.jobIds.length} proxy=${proxyUrl ? "ISP" : "none"}`,
    "info"
  ).catch(() => {});

  // Launch browser
  browser = await launchBrowser({ proxyUrl });
  context = await createContext(browser, {
    userAgent: USER_AGENTS[uaIndex],
    viewport: VIEWPORTS[uaIndex % VIEWPORTS.length],
    proxyUrl,
    timezone: account.country === "CA" ? "America/Toronto" : "America/New_York",
  });

  // Track active page for screenshots and browser console forwarding
  context.on("page", (page) => {
    activePage = page;
    page.on("console", (msg) => {
      const payload = JSON.stringify({ level: msg.type(), text: msg.text(), ts: Date.now() });
      // Live stream for open panels
      redis.publish(`worker:console:${ACCOUNT_ID}`, payload).catch(() => {});
      // Persistent history (last 500 messages, 24h TTL)
      redis.rpush(`worker:console:log:${ACCOUNT_ID}`, payload)
        .then(() => redis.ltrim(`worker:console:log:${ACCOUNT_ID}`, -500, -1))
        .then(() => redis.expire(`worker:console:log:${ACCOUNT_ID}`, 86400))
        .catch(() => {});
    });
    page.on("close", () => {
      if (activePage === page) {
        // Fall back to another open page instead of going null
        const pages = context!.pages();
        activePage = pages.find(p => p !== page) ?? null;
      }
    });
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
    await runLogger.log(`Login successful — session established`, "info").catch(() => {});
  } catch (err) {
    const reason = String(err);
    console.error(`[Worker:${ACCOUNT_ID}] Login failed:`, err);
    await runLogger.log(`Login failed: ${reason}`, "error").catch(() => {});
    await setState(bus, "ERROR");
    await bus.publish("worker:crashed", {
      accountId: ACCOUNT_ID,
      email: account.email,
      reason,
    });
    await shutdown(reason);
    return;
  }

  await setState(bus, "POLLING");

  // The login page is now on hiring.amazon.ca/app#/jobSearch — keep it as
  // the dedicated polling page. apply.ts always opens its own newPage(), so
  // this page will never be navigated away by the apply flow.
  const pollingPage = context.pages().find(p => p.url().includes("jobSearch"))
    ?? context.pages()[context.pages().length - 1];

  // Store token in Redis so orchestrator can use it for rate-limit tests
  await redis.set(`worker:token:${ACCOUNT_ID}`, accessToken, "EX", 3600);

  // Subscribe to rate-control commands from orchestrator dashboard
  cmdSub = redis.duplicate();
  await cmdSub.subscribe(`poller:cmd:${ACCOUNT_ID}`, `worker:test-cmd:${ACCOUNT_ID}`);
  cmdSub.on("message", (_ch, raw) => {
    try {
      const cmd = JSON.parse(raw);
      if (cmd.type === "setInterval" && typeof cmd.intervalMs === "number") {
        poller?.setIntervalMs(cmd.intervalMs);
      }
      // Rate-limit test command — runs inside the worker's authenticated browser
      if (cmd.testId && cmd.jobId) {
        const rpms: number[] = cmd.rpms ?? [5, 10, 20, 30, 40, 50, 60, 80, 100];
        if (cmd.proxyType === "rotating_dc") {
          poller?.runRotatingProxyTest(cmd.testId, cmd.jobId, rpms).catch(console.error);
        } else {
          poller?.runRateLimitTest(cmd.testId, cmd.jobId, rpms).catch(console.error);
        }
      }
    } catch { /* ignore malformed */ }
  });

  // Subscribe to job:captured events for THIS account to trigger apply
  const sub = redis.duplicate();
  await sub.subscribe(`event:job:captured`);
  sub.on("message", async (_channel, raw) => {
    try {
      const event = JSON.parse(raw);
      if (event.payload?.accountId !== ACCOUNT_ID) return;
      if (!running) return;

      const { applyUrl, email } = event.payload;
      await runLogger.log(`Apply triggered: ${applyUrl.slice(0, 80)}`, "info").catch(() => {});
      await setState(bus, "APPLYING");
      const success = await applyForJob(context!, applyUrl, email);

      if (success) {
        await runLogger.log(`Apply successful: scheduleId=${event.payload.scheduleId}`, "info").catch(() => {});
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

  // Start polling — requests go through the browser page so session cookies
  // are automatically included (same mechanism as the old Chrome extension's pageFetch)
  poller = new JobPoller(
    {
      accountId: ACCOUNT_ID,
      email: account.email,
      country: account.country,
      jobIds: account.jobIds,
      accessToken,
      page: pollingPage,
      intervalMs: 5_000,
      runLogger,
      redis,
      rotatingDcProxyUrl,
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
    await runLogger.log(`Session expired — re-logging in`, "warn").catch(() => {});
    poller?.stop();
    await setState(bus, "LOGGING_IN");
    try {
      const newToken = await login(context!, {
        email: account.email,
        pin: account.pin,
        country: account.country,
        accountId: ACCOUNT_ID,
      });
      await runLogger.log(`Re-login successful`, "info").catch(() => {});
      await redis.set(`worker:token:${ACCOUNT_ID}`, newToken, "EX", 3600);
      const newPollingPage = context!.pages().find(p => p.url().includes("jobSearch"))
        ?? context!.pages()[context!.pages().length - 1];
      poller!.updateToken(newToken);
      poller!.updatePage(newPollingPage);
      await setState(bus, "POLLING");
      poller!.start(); // restart
    } catch (err) {
      console.error(`[Worker:${ACCOUNT_ID}] Re-login failed:`, err);
      await runLogger.log(`Re-login failed: ${String(err)}`, "error").catch(() => {});
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
