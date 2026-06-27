import { chromium } from "playwright";
import type { Page } from "playwright";
import type Redis from "ioredis";
import { parseProxyUrl } from "../browser/launch";
import type { EventBus } from "../events/event-bus";
import type { RunLogger } from "../RunLogger";

const TEST_LOG_TTL = 30 * 24 * 60 * 60; // 30 days

export interface JobPollerConfig {
  accountId: string;
  email: string;
  country: "CA" | "US";
  jobIds: string[];
  accessToken: string;
  page: Page;
  intervalMs?: number;
  runLogger?: RunLogger;
  redis?: Redis;
  rotatingDcProxyUrl?: string;
}

interface Schedule {
  scheduleId: string;
  laborDemandAvailableCount: number;
  startDateAvailableCount?: number;
  scheduleStatusReason: string | string[];
  aggregatedScheduleStatus: string;
  status?: string;
  firstShiftStartTime?: string;
  externalJobTitle?: string;
  siteId?: string;
  metricSiteId?: string;
  address?: { city?: string };
}

interface PageFetchResult {
  status: number;
  body: string;
  ok: boolean;
}

const DOMAIN = (country: "CA" | "US") =>
  country === "CA" ? "hiring.amazon.ca" : "hiring.amazon.com";

const DEFAULT_INTERVAL_MS = 334;   // ~180 RPM
const PEAK_INTERVAL_MS    = 300;   // ~200 RPM — 5:55–6:10 AM
const MAX_BACKOFF_MS      = 60_000;

export class JobPoller {
  private running = false;
  private backoffMultiplier = 1;
  private consecutiveEmpty = 0;
  private recentTicks: number[] = [];

  constructor(private config: JobPollerConfig, private bus: EventBus) {}

  async start() {
    this.running = true;
    const interval0 = this.config.intervalMs ?? DEFAULT_INTERVAL_MS;
    console.log(`[Poller:${this.config.email}] Starting poll loop for ${this.config.jobIds.length} jobs via browser fetch`);
    await this.config.runLogger?.log(
      `Poll loop started — ${this.config.jobIds.length} job(s), interval=${interval0}ms (~${Math.round(60_000 / interval0)} RPM)`,
      "info"
    ).catch(() => {});

    const warmupEnd = Date.now() + 2 * 60_000;

    while (this.running) {
      const isWarmup = Date.now() < warmupEnd;
      const interval = isWarmup ? 60_000 : this.effectiveInterval();

      try {
        await this.pollOnce(isWarmup, interval);
        this.backoffMultiplier = 1;
      } catch (err: unknown) {
        await this.handleError(err);
      }

      if (!this.running) break;
      await sleep(jitter(interval));
    }

    console.log(`[Poller:${this.config.email}] Poll loop stopped`);
    await this.config.runLogger?.log(`Poll loop stopped`, "info").catch(() => {});
  }

  stop() { this.running = false; }

  updateToken(token: string) {
    this.config.accessToken = token;
  }

  updatePage(page: Page) {
    this.config.page = page;
  }

  setIntervalMs(ms: number) {
    const minSafe = 300; // floor at 200 RPM
    this.config.intervalMs = Math.max(ms, minSafe);
    console.log(`[Poller:${this.config.email}] Interval → ${this.config.intervalMs}ms (~${Math.round(60_000 / this.config.intervalMs)} RPM, requested ${ms}ms)`);
  }

  private async pollOnce(isWarmup: boolean, intervalMs: number) {
    const country = this.config.country;
    const locale  = country === "CA" ? "en-CA" : "en-US";
    const domain  = DOMAIN(country);

    for (const jobId of this.config.jobIds) {
      if (!this.running) return;

      const start = Date.now();
      let result: PageFetchResult;

      try {
        result = await this.browserFetch(
          `https://${domain}/application/api/job/get-all-schedules/${jobId}`,
          { jobId, locale, pageSize: 100 },
        );
      } catch (err) {
        const durationMs = Date.now() - start;
        const msg = err instanceof Error ? err.message : String(err);
        await this.config.runLogger?.log(`Poll error on ${jobId}: ${msg}`, "error").catch(() => {});
        await this.emitTick({ jobId, result: "error", error: msg, statusCode: undefined, durationMs, isWarmup, intervalMs }).catch(() => {});
        throw err;
      }

      const durationMs = Date.now() - start;
      this.trackTick();

      if (result.status === 401) {
        await this.config.runLogger?.log(`Session expired (401) on ${jobId} — re-login triggered`, "warn").catch(() => {});
        await this.emitTick({ jobId, result: "error", error: "401 session expired", statusCode: 401, durationMs, isWarmup, intervalMs }).catch(() => {});
        this.running = false;
        await this.bus.publish("session:expired", { accountId: this.config.accountId, email: this.config.email });
        return;
      }

      if (result.status === 403 || result.status === 429) {
        await this.emitTick({ jobId, result: "throttled", statusCode: result.status, durationMs, isWarmup, intervalMs }).catch(() => {});
        this.backoffMultiplier = Math.min(this.backoffMultiplier * 2, 8);
        const wait = Math.min(5_000 * this.backoffMultiplier, MAX_BACKOFF_MS);
        console.warn(`[Poller:${this.config.email}] ${result.status} throttled — backing off ${wait}ms (×${this.backoffMultiplier})`);
        await this.config.runLogger?.log(`Throttled (${result.status}) on ${jobId} — backing off ${wait}ms (×${this.backoffMultiplier})`, "warn").catch(() => {});
        await sleep(wait);
        continue;
      }

      if (!result.ok || result.body.toLowerCase().includes("cloudfront")) {
        const isCloudFront = result.body.toLowerCase().includes("cloudfront");
        await this.emitTick({ jobId, result: "error", error: isCloudFront ? "CloudFront block" : `HTTP ${result.status}`, statusCode: result.status, durationMs, isWarmup, intervalMs }).catch(() => {});
        if (isCloudFront) {
          this.backoffMultiplier = Math.min(this.backoffMultiplier * 2, 8);
          const wait = Math.min(10_000 * this.backoffMultiplier, MAX_BACKOFF_MS);
          console.warn(`[Poller:${this.config.email}] CloudFront block — waiting ${wait}ms`);
          await this.config.runLogger?.log(`CloudFront block on ${jobId} — waiting ${wait}ms (×${this.backoffMultiplier})`, "warn").catch(() => {});
          await sleep(wait);
        }
        continue;
      }

      let data: unknown;
      try {
        data = JSON.parse(result.body);
      } catch {
        await this.emitTick({ jobId, result: "error", error: "JSON parse failed", statusCode: result.status, durationMs, isWarmup, intervalMs }).catch(() => {});
        continue;
      }

      // Parse exactly like the old Chrome extension (fetch.js lines 423-425):
      // available = result.data.availableSchedules || result.data || result.availableSchedules || result
      // schedules = available.schedules || available
      const r = data as Record<string, unknown>;
      const rData = r?.data as Record<string, unknown> | undefined;
      const available: unknown = rData
        ? (rData.availableSchedules ?? rData)
        : (r?.availableSchedules ?? r);
      const rawSchedules: unknown = (available as Record<string, unknown>)?.schedules ?? available;
      const schedules: Schedule[] = Array.isArray(rawSchedules) ? (rawSchedules as Schedule[]) : [];

      if (!Array.isArray(rawSchedules) && this.recentTicks.length <= 2) {
        console.warn(`[Poller:${this.config.email}] Unexpected response shape for ${jobId}:`, JSON.stringify(data)?.slice(0, 250));
      }

      const active = schedules.filter((s) => {
        const hasSlots = s.laborDemandAvailableCount > 0 || (s.startDateAvailableCount ?? 0) > 0;
        const statusReasonActive = Array.isArray(s.scheduleStatusReason)
          ? s.scheduleStatusReason.includes("Active")
          : typeof s.scheduleStatusReason === "string" && s.scheduleStatusReason.includes("Active");
        const statusActive = s.status === "ACTIVE" || s.aggregatedScheduleStatus === "ACTIVE";
        return hasSlots && (statusReasonActive || statusActive);
      });

      const slotsFound = active.reduce((n, s) => n + s.laborDemandAvailableCount, 0);

      await this.emitTick({ jobId, result: active.length > 0 ? "active" : "empty", slotsFound, statusCode: 200, durationMs, isWarmup, intervalMs });

      if (active.length > 0) {
        for (const schedule of active) {
          await this.config.runLogger?.log(
            `JOB FOUND: ${jobId} scheduleId=${schedule.scheduleId} slots=${schedule.laborDemandAvailableCount}`,
            "info"
          ).catch(() => {});
          await this.captureJob(jobId, schedule);
        }
        this.consecutiveEmpty = 0;
      } else {
        this.consecutiveEmpty++;
      }

      // Adaptive stagger: space jobs within a cycle at the same interval as the cycle itself.
      // This keeps total RPM = 60000/intervalMs regardless of how many jobs are monitored.
      if (this.running && jobId !== this.config.jobIds[this.config.jobIds.length - 1]) {
        const stagger = Math.max(200, Math.min(2_000, intervalMs));
        await sleep(stagger * (0.9 + Math.random() * 0.2));
      }
    }

    if (this.consecutiveEmpty > 100) {
      await this.config.runLogger?.log(
        `Possible shadow ban — ${this.consecutiveEmpty} consecutive empty responses`,
        "warn"
      ).catch(() => {});
      await this.bus.publish("account:possible_shadow_ban", {
        accountId: this.config.accountId,
        email: this.config.email,
        consecutiveEmpty: this.consecutiveEmpty,
      });
      this.consecutiveEmpty = 0;
    }
  }

  // Run fetch() inside the Playwright browser page — this sends session cookies
  // automatically (credentials: 'include'), exactly like the old Chrome extension did
  // via chrome.scripting.executeScript with world: 'MAIN'.
  private async browserFetch(url: string, body: object, page?: Page): Promise<PageFetchResult> {
    const targetPage = page ?? this.config.page;
    const token = this.config.accessToken;

    const result = await targetPage.evaluate(
      async ({ url, body, token }) => {
        try {
          const resp = await fetch(url, {
            method: "POST",
            credentials: "include",
            headers: {
              "Content-Type": "application/json",
              "Accept": "application/json, text/plain, */*",
              "bb-ui-version": "bb-ui-v2",
              "authorization": token,
            },
            body: JSON.stringify(body),
          });
          const text = await resp.text();
          return { status: resp.status, body: text, ok: resp.ok };
        } catch (e: unknown) {
          return { status: 0, body: String(e), ok: false };
        }
      },
      { url, body, token },
    );

    return result;
  }

  private async captureJob(jobId: string, schedule: Schedule) {
    const country = this.config.country;
    const cc      = country === "CA" ? "CA" : "US";
    const locale  = country === "CA" ? "en-CA" : "en-US";
    const domain  = DOMAIN(country);

    const applyUrl =
      `https://${domain}/application/${cc}/?CS=true&jobId=${jobId}` +
      `&locale=${locale}&scheduleId=${schedule.scheduleId}&ssoEnabled=1#/consent`;

    console.log(`[Poller:${this.config.email}] 🎯 JOB FOUND — jobId=${jobId} scheduleId=${schedule.scheduleId}`);

    await this.bus.publish("job:captured", {
      accountId: this.config.accountId,
      email: this.config.email,
      jobId,
      scheduleId: schedule.scheduleId,
      jobTitle: schedule.externalJobTitle,
      location: schedule.address?.city,
      site: schedule.siteId ?? schedule.metricSiteId,
      applyUrl,
      shiftTime: schedule.firstShiftStartTime,
      slotsAvailable: schedule.laborDemandAvailableCount,
    });
  }

  // Run an escalating RPM rate-limit test from within this browser session.
  // Uses the same browserFetch as real polling, so results reflect actual limits.
  // Accepts an optional page override for the rotating proxy test.
  async runRateLimitTest(testId: string, jobId: string, rpms: number[], page?: Page) {
    const domain = DOMAIN(this.config.country);
    const locale = this.config.country === "CA" ? "en-CA" : "en-US";
    const url    = `https://${domain}/application/api/job/get-all-schedules/${jobId}`;
    const body   = { jobId, locale, pageSize: 100 };
    const REQUESTS = 5;
    const redis  = this.config.redis;

    const storeTestLog = async (message: string, level: string) => {
      if (!redis) return;
      const entry = JSON.stringify({ ts: Date.now(), level, message });
      redis.rpush(`test:logs:${testId}`, entry).catch(() => {});
      redis.expire(`test:logs:${testId}`, TEST_LOG_TTL).catch(() => {});
    };

    const log = async (message: string, level: "info" | "warn" | "success" | "error") => {
      console.log(`[RateTest:${testId}] ${message}`);
      await Promise.all([
        this.bus.publish("test:log", { testId, message, level, timestamp: Date.now() }),
        storeTestLog(message, level),
      ]);
    };

    await log(`Rate limit test started — jobId=${jobId} rpms=${rpms.join(",")}`, "info");
    await log(`Using worker browser session for ${this.config.email}`, "info");

    interface RpmResult { rpm: number; sent: number; success: number; throttled: number; errors: number; avgLatencyMs: number }
    const results: RpmResult[] = [];
    let hitThrottle = false;

    for (const rpm of rpms) {
      if (hitThrottle) break;

      const intervalMs = Math.round(60_000 / rpm);
      let success = 0, throttled = 0, errors = 0;
      const latencies: number[] = [];

      await log(`── ${rpm} RPM  (${intervalMs}ms gap, ${REQUESTS} requests) ──`, "info");

      for (let i = 0; i < REQUESTS; i++) {
        await log(`→ req ${i + 1}/${REQUESTS}  POST ${url.replace(/^https:\/\/[^/]+/, "")}`, "info");
        const start = Date.now();
        try {
          const r = await this.browserFetch(url, body, page);
          const ms = Date.now() - start;
          latencies.push(ms);

          // Show first 200 chars of body as preview (strip newlines for log readability)
          const preview = r.body.replace(/\s+/g, " ").slice(0, 200);

          if (r.status === 200) {
            success++;
            await log(`← ${r.status} OK  (${ms}ms)  ${preview}`, "success");
          } else if (r.status === 403 || r.status === 429) {
            throttled++;
            await log(`← ${r.status} THROTTLED  (${ms}ms)  ${preview}`, "warn");
          } else {
            errors++;
            await log(`← ${r.status} ERROR  (${ms}ms)  ${preview}`, "error");
          }
        } catch (e) {
          const ms = Date.now() - start;
          latencies.push(ms);
          errors++;
          await log(`← NETWORK ERROR  (${ms}ms)  ${e instanceof Error ? e.message : String(e)}`, "error");
        }
        if (i < REQUESTS - 1) await sleep(intervalMs);
      }

      const avgLatencyMs = latencies.length > 0
        ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0;
      const result: RpmResult = { rpm, sent: REQUESTS, success, throttled, errors, avgLatencyMs };
      results.push(result);

      await this.bus.publish("test:rpmResult", { testId, phase: "worker_browser", rpm, sent: REQUESTS, success, throttled, errors, avgLatencyMs });
      await log(`${rpm} RPM → ✓${success} 🚫${throttled} ✗${errors} avg=${avgLatencyMs}ms`,
        throttled > REQUESTS * 0.5 ? "warn" : "success");

      if (throttled > REQUESTS * 0.5) {
        await log(`Throttle rate ${Math.round(throttled / REQUESTS * 100)}% > 50% — stopping`, "warn");
        hitThrottle = true;
        break;
      }

      await log(`Cooling down 5s...`, "info");
      await sleep(5_000);
    }

    const safe = results.filter(r => r.throttled / r.sent <= 0.5);
    const maxSafeRpm = safe.length > 0 ? safe[safe.length - 1].rpm : 0;
    await this.bus.publish("test:phaseComplete", { testId, phase: "worker_browser", results, maxSafeRpm });
    await this.bus.publish("test:complete", { testId, phases: [{ phase: "worker_browser", results, maxSafeRpm }] });
    await log(`Test complete — max safe RPM: ${maxSafeRpm}`, maxSafeRpm > 0 ? "success" : "warn");

    if (redis) {
      const resultPayload = JSON.stringify({
        testId,
        phases: [{ phase: "worker_browser", results, maxSafeRpm }],
        completedAt: Date.now(),
      });
      await redis.set(`test:results:${testId}`, resultPayload, "EX", TEST_LOG_TTL).catch(() => {});

      const rawMeta = await redis.get(`test:meta:${testId}`).catch(() => null);
      if (rawMeta) {
        const meta = JSON.parse(rawMeta);
        meta.status = "completed";
        meta.endedAt = Date.now();
        meta.maxSafeRpm = maxSafeRpm;
        await redis.set(`test:meta:${testId}`, JSON.stringify(meta), "EX", TEST_LOG_TTL).catch(() => {});
      }
    }
  }

  // Rotating DC proxy test — spins up a separate Chromium instance with the
  // datacenter rotating proxy, copies session cookies from the main browser,
  // and runs the same RPM escalation. Each request comes from a different
  // datacenter IP so the results show whether rate-limiting is per-IP or per-session.
  async runRotatingProxyTest(testId: string, jobId: string, rpms: number[]) {
    const rotatingUrl = this.config.rotatingDcProxyUrl;
    const redis = this.config.redis;

    const log = async (message: string, level: "info" | "warn" | "success" | "error") => {
      console.log(`[RotatingTest:${testId}] ${message}`);
      await this.bus.publish("test:log", { testId, message, level, timestamp: Date.now() });
      if (redis) {
        const entry = JSON.stringify({ ts: Date.now(), level, message });
        redis.rpush(`test:logs:${testId}`, entry).catch(() => {});
        redis.expire(`test:logs:${testId}`, TEST_LOG_TTL).catch(() => {});
      }
    };

    if (!rotatingUrl) {
      await log("No rotating DC proxy configured (BRIGHTDATA_DC_* env vars missing)", "error");
      await this.bus.publish("test:complete", { testId, phases: [] });
      return;
    }

    await log(`Rotating DC proxy test — launching isolated browser with rotating IPs`, "info");
    await log(`Proxy: ${rotatingUrl.replace(/:([^@]+)@/, ":***@")}`, "info");

    // Copy cookies from the authenticated main browser session
    const cookies = await this.config.page.context().cookies();
    await log(`Copied ${cookies.length} session cookies from main browser`, "info");

    const domain = DOMAIN(this.config.country);

    // Launch an isolated browser that routes through the rotating DC proxy.
    // No session ID in the username → Bright Data assigns a fresh IP per TCP connection.
    const proxy = parseProxyUrl(rotatingUrl);
    const browser = await chromium.launch({
      headless: false,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-blink-features=AutomationControlled",
      ],
      proxy,
    });

    try {
      const context = await browser.newContext({
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        locale: "en-CA",
        timezoneId: this.config.country === "CA" ? "America/Toronto" : "America/New_York",
      });

      // Import the authenticated session cookies into the rotating browser
      await context.addCookies(cookies);

      const page = await context.newPage();
      await log(`Navigating to Amazon hiring portal via rotating proxy...`, "info");

      try {
        await page.goto(`https://${domain}/app#/jobSearch`, { waitUntil: "domcontentloaded", timeout: 30_000 });
        await log(`Navigation OK — running escalating RPM test`, "info");
      } catch (e) {
        await log(`Navigation failed: ${e instanceof Error ? e.message : e} — cookies may be IP-bound`, "error");
        await this.bus.publish("test:complete", { testId, phases: [] });
        return;
      }

      // Delegate to the same core test runner (with the rotating page)
      await this.runRateLimitTest(testId, jobId, rpms, page);
    } finally {
      await browser.close();
      await log("Rotating proxy browser closed", "info");
    }
  }

  private async handleError(err: unknown) {
    console.error(`[Poller:${this.config.email}] Poll error:`, err);
  }

  private effectiveInterval(): number {
    const base = this.config.intervalMs ?? DEFAULT_INTERVAL_MS;
    const now  = new Date();
    const h    = now.getHours();
    const m    = now.getMinutes();
    const isPeak = (h === 5 && m >= 55) || (h === 6 && m <= 10);
    if (isPeak) return PEAK_INTERVAL_MS;
    return Math.max(base, 300); // floor: 300ms = 200 RPM max
  }

  private trackTick() {
    const now = Date.now();
    this.recentTicks.push(now);
    const cutoff = now - 60_000;
    this.recentTicks = this.recentTicks.filter(t => t > cutoff);
  }

  private estimatedRpm(): number {
    const now = Date.now();
    const cutoff = now - 60_000;
    return this.recentTicks.filter(t => t > cutoff).length;
  }

  private async emitTick(fields: {
    jobId: string;
    result: "active" | "empty" | "error" | "throttled";
    slotsFound?: number;
    error?: string;
    statusCode?: number;
    durationMs: number;
    isWarmup: boolean;
    intervalMs: number;
  }) {
    const tick = {
      accountId:    this.config.accountId,
      email:        this.config.email,
      jobId:        fields.jobId,
      result:       fields.result,
      slotsFound:   fields.slotsFound ?? 0,
      error:        fields.error ?? null,
      statusCode:   fields.statusCode ?? null,
      durationMs:   fields.durationMs,
      isWarmup:     fields.isWarmup,
      intervalMs:   fields.intervalMs,
      estimatedRpm: this.estimatedRpm(),
      consecutiveEmpty: this.consecutiveEmpty,
      timestamp:    Date.now(),
    };
    await this.bus.publish("poll:tick", tick);
    const rl = this.config.runLogger;
    if (rl) {
      rl.incrementStat("total").catch(() => {});
      rl.incrementStat(fields.result).catch(() => {});
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function jitter(ms: number): number {
  return ms * (0.7 + Math.random() * 0.6);
}
