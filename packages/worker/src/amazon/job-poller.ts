import axios, { type AxiosInstance } from "axios";
import type { EventBus } from "../events/event-bus";

export interface JobPollerConfig {
  accountId: string;
  email: string;
  country: "CA" | "US";
  jobIds: string[];
  accessToken: string;
  intervalMs?: number; // base interval, jittered ±30%
}

interface Schedule {
  scheduleId: string;
  laborDemandAvailableCount: number;
  scheduleStatusReason: string;
  aggregatedScheduleStatus: string;
  firstShiftStartTime?: string;
  externalJobTitle?: string;
  address?: { city?: string };
}

const DOMAIN = (country: "CA" | "US") =>
  country === "CA" ? "hiring.amazon.ca" : "hiring.amazon.com";

const DEFAULT_INTERVAL_MS = 5_000;
// During peak hours (5:55–6:10 AM local) reduce to 1s
const PEAK_INTERVAL_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;

export class JobPoller {
  private running = false;
  private client: AxiosInstance;
  private backoffMultiplier = 1;
  private consecutiveEmpty = 0;

  constructor(private config: JobPollerConfig, private bus: EventBus) {
    this.client = axios.create({
      baseURL: `https://${DOMAIN(config.country)}`,
      headers: {
        authorization: config.accessToken,
        "Content-Type": "application/json",
        accept: "application/json, text/plain, */*",
        "accept-language": "en-CA,en;q=0.9",
        "x-requested-with": "XMLHttpRequest",
      },
    });
  }

  async start() {
    this.running = true;
    console.log(`[Poller:${this.config.email}] Starting poll loop for ${this.config.jobIds.length} jobs`);

    // Warm-up: slow poll for first 2 minutes to avoid rate limits on fresh sessions
    const warmupEnd = Date.now() + 2 * 60 * 1000;

    while (this.running) {
      const isWarmup = Date.now() < warmupEnd;
      const interval = isWarmup ? 60_000 : this.effectiveInterval();

      try {
        await this.pollOnce();
        this.backoffMultiplier = 1;
      } catch (err: unknown) {
        await this.handleError(err);
      }

      if (!this.running) break;
      await sleep(jitter(interval));
    }

    console.log(`[Poller:${this.config.email}] Poll loop stopped`);
  }

  stop() {
    this.running = false;
  }

  updateToken(token: string) {
    this.config.accessToken = token;
    this.client.defaults.headers["authorization"] = token;
  }

  private async pollOnce() {
    const country = this.config.country;
    const locale = country === "CA" ? "en-CA" : "en-US";

    for (const jobId of this.config.jobIds) {
      if (!this.running) return;

      const resp = await this.client.post(
        `/application/api/job/get-all-schedules/${jobId}`,
        { jobId, locale, pageSize: 100 }
      );

      const schedules: Schedule[] = resp.data?.data?.availableSchedules ?? [];
      const active = schedules.filter(
        (s) =>
          s.laborDemandAvailableCount > 0 &&
          s.aggregatedScheduleStatus === "ACTIVE" &&
          s.scheduleStatusReason?.includes("Active")
      );

      if (active.length > 0) {
        for (const schedule of active) {
          await this.captureJob(jobId, schedule);
        }
      }

      // Stagger between jobs
      await sleep(300 + Math.random() * 900);
    }

    this.consecutiveEmpty++;
    // Shadow-ban heuristic: if >100 consecutive empty polls, flag
    if (this.consecutiveEmpty > 100) {
      await this.bus.publish("account:possible_shadow_ban", {
        accountId: this.config.accountId,
        email: this.config.email,
        consecutiveEmpty: this.consecutiveEmpty,
      });
      this.consecutiveEmpty = 0;
    }
  }

  private async captureJob(jobId: string, schedule: Schedule) {
    const country = this.config.country;
    const cc = country === "CA" ? "CA" : "US";
    const locale = country === "CA" ? "en-CA" : "en-US";
    const domain = DOMAIN(country);

    const applyUrl =
      `https://${domain}/application/${cc}/?CS=true&jobId=${jobId}` +
      `&locale=${locale}&scheduleId=${schedule.scheduleId}&ssoEnabled=1#/consent`;

    console.log(`[Poller:${this.config.email}] 🎯 JOB FOUND — jobId=${jobId} scheduleId=${schedule.scheduleId}`);

    this.consecutiveEmpty = 0;

    await this.bus.publish("job:captured", {
      accountId: this.config.accountId,
      email: this.config.email,
      jobId,
      scheduleId: schedule.scheduleId,
      jobTitle: schedule.externalJobTitle,
      location: schedule.address?.city,
      applyUrl,
      shiftTime: schedule.firstShiftStartTime,
      slotsAvailable: schedule.laborDemandAvailableCount,
    });

    return applyUrl;
  }

  private async handleError(err: unknown) {
    if (!axios.isAxiosError(err)) {
      console.error(`[Poller:${this.config.email}] Unexpected error:`, err);
      return;
    }

    const status = err.response?.status;

    if (status === 401) {
      console.warn(`[Poller:${this.config.email}] 401 — session expired`);
      this.running = false;
      await this.bus.publish("session:expired", {
        accountId: this.config.accountId,
        email: this.config.email,
      });
      return;
    }

    if (status === 429 || status === 403) {
      this.backoffMultiplier = Math.min(this.backoffMultiplier * 2, 8);
      const wait = Math.min(5_000 * this.backoffMultiplier, MAX_BACKOFF_MS);
      console.warn(`[Poller:${this.config.email}] ${status} throttled — backing off ${wait}ms (×${this.backoffMultiplier})`);
      await sleep(wait);
      return;
    }

    // Check for CloudFront HTML block
    const body = err.response?.data;
    if (typeof body === "string" && body.includes("CloudFront")) {
      this.backoffMultiplier = Math.min(this.backoffMultiplier * 2, 8);
      const wait = Math.min(10_000 * this.backoffMultiplier, MAX_BACKOFF_MS);
      console.warn(`[Poller:${this.config.email}] CloudFront block — waiting ${wait}ms`);
      await sleep(wait);
      return;
    }

    console.error(`[Poller:${this.config.email}] HTTP ${status}:`, err.message);
  }

  private effectiveInterval(): number {
    const base = this.config.intervalMs ?? DEFAULT_INTERVAL_MS;
    const now = new Date();
    const h = now.getHours();
    const m = now.getMinutes();
    // Peak: 5:55 AM – 6:10 AM
    const isPeak = (h === 5 && m >= 55) || (h === 6 && m <= 10);
    return isPeak ? PEAK_INTERVAL_MS : base;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function jitter(ms: number): number {
  return ms * (0.7 + Math.random() * 0.6); // ±30%
}
