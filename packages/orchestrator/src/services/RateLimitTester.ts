import axios from "axios";
import { HttpsProxyAgent } from "https-proxy-agent";
import type { EventBus } from "../events/EventBus";

export interface RateLimitTestConfig {
  testId: string;
  token: string;
  jobId: string;
  country: "CA" | "US";
  phases: Array<"direct" | "proxy_fixed" | "proxy_rotating">;
}

export interface RpmResult {
  rpm: number;
  sent: number;
  success: number;
  throttled: number;
  errors: number;
  avgLatencyMs: number;
}

export interface PhaseResult {
  phase: string;
  results: RpmResult[];
  maxSafeRpm: number;
}

// Escalating RPM levels to test
const RPM_LEVELS = [5, 10, 20, 30, 40, 50, 60, 80, 100];
// Number of requests to send per RPM level
const REQUESTS_PER_LEVEL = 5;

const DOMAIN = (c: "CA" | "US") => c === "CA" ? "hiring.amazon.ca" : "hiring.amazon.com";

export class RateLimitTester {
  private running = false;

  constructor(
    private bus: EventBus,
    private brightdataHost: string,
    private brightdataPort: number,
    private brightdataUser: string,
    private brightdataPass: string,
  ) {}

  stop() { this.running = false; }

  async run(config: RateLimitTestConfig): Promise<void> {
    this.running = true;
    const { testId } = config;

    await this.log(testId, `Rate limit test started — jobId=${config.jobId} country=${config.country} phases=${config.phases.join(",")}`, "info");

    const allPhaseResults: PhaseResult[] = [];

    for (const phase of config.phases) {
      if (!this.running) break;
      const phaseResult = await this.runPhase(config, phase);
      allPhaseResults.push(phaseResult);

      await this.bus.publish("test:phaseComplete", {
        testId,
        phase,
        maxSafeRpm: phaseResult.maxSafeRpm,
        results: phaseResult.results,
      });
    }

    if (this.running) {
      await this.bus.publish("test:complete", {
        testId,
        phases: allPhaseResults,
        summary: allPhaseResults.map(p => ({ phase: p.phase, maxSafeRpm: p.maxSafeRpm })),
      });
      await this.log(testId, `Test complete. Results: ${allPhaseResults.map(p => `${p.phase}=${p.maxSafeRpm}RPM`).join(", ")}`, "success");
    } else {
      await this.log(testId, "Test cancelled by user", "warn");
      await this.bus.publish("test:cancelled", { testId });
    }

    this.running = false;
  }

  private async runPhase(config: RateLimitTestConfig, phase: string): Promise<PhaseResult> {
    const { testId } = config;
    await this.log(testId, `=== Phase: ${phase.toUpperCase()} ===`, "info");

    const results: RpmResult[] = [];
    let hitThrottle = false;

    for (const rpm of RPM_LEVELS) {
      if (!this.running) break;
      if (hitThrottle) {
        // Mark remaining levels as untested (throttled assumed)
        results.push({ rpm, sent: 0, success: 0, throttled: REQUESTS_PER_LEVEL, errors: 0, avgLatencyMs: 0 });
        continue;
      }

      await this.log(testId, `[${phase}] Testing ${rpm} RPM...`, "info");
      const result = await this.testRpm(config, phase, rpm);
      results.push(result);

      const throttleRate = result.sent > 0 ? result.throttled / result.sent : 0;
      await this.bus.publish("test:rpmResult", { testId, phase, ...result });
      await this.log(
        testId,
        `[${phase}] ${rpm} RPM → ✓${result.success} 🚫${result.throttled} ✗${result.errors} avg=${result.avgLatencyMs}ms`,
        throttleRate > 0.5 ? "warn" : "info",
      );

      if (throttleRate > 0.5) {
        await this.log(testId, `[${phase}] Throttle rate ${Math.round(throttleRate * 100)}% > 50% — stopping escalation`, "warn");
        hitThrottle = true;
      }

      // Brief pause between RPM levels to let rate limiters reset
      if (!hitThrottle && this.running) {
        await this.log(testId, `[${phase}] Cooling down 5s before next RPM level...`, "info");
        await sleep(5_000);
      }
    }

    // Max safe RPM = last level where throttleRate ≤ 50%
    const safeResults = results.filter(r => r.sent > 0 && r.throttled / r.sent <= 0.5);
    const maxSafeRpm = safeResults.length > 0 ? safeResults[safeResults.length - 1].rpm : 0;
    await this.log(testId, `[${phase}] Max safe RPM: ${maxSafeRpm}`, maxSafeRpm > 0 ? "success" : "warn");

    return { phase, results, maxSafeRpm };
  }

  private async testRpm(config: RateLimitTestConfig, phase: string, rpm: number): Promise<RpmResult> {
    const intervalMs = Math.round(60_000 / rpm);
    const domain = DOMAIN(config.country);
    const url = `https://${domain}/application/api/job/get-all-schedules/${config.jobId}`;
    const body = { jobId: config.jobId, locale: config.country === "CA" ? "en-CA" : "en-US", pageSize: 100 };
    const headers = {
      authorization: config.token,
      "Content-Type": "application/json",
      accept: "application/json, text/plain, */*",
      "accept-language": "en-CA,en;q=0.9",
      "x-requested-with": "XMLHttpRequest",
      "bb-ui-version": "bb-ui-v2",
    };

    let success = 0, throttled = 0, errors = 0;
    const latencies: number[] = [];

    for (let i = 0; i < REQUESTS_PER_LEVEL; i++) {
      if (!this.running) break;

      const proxyOpts = this.buildProxy(phase, i);
      const start = Date.now();

      try {
        const resp = await axios.post(url, body, {
          headers,
          ...proxyOpts,
          timeout: 15_000,
          validateStatus: () => true, // don't throw on 4xx/5xx
        });
        latencies.push(Date.now() - start);

        const status: number = resp.status;
        if (status === 200) success++;
        else if (status === 403 || status === 429) throttled++;
        else errors++;
      } catch {
        latencies.push(Date.now() - start);
        errors++;
      }

      if (i < REQUESTS_PER_LEVEL - 1 && this.running) {
        await sleep(intervalMs);
      }
    }

    const avgLatencyMs = latencies.length > 0
      ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
      : 0;

    return { rpm, sent: REQUESTS_PER_LEVEL, success, throttled, errors, avgLatencyMs };
  }

  private buildProxy(phase: string, requestIndex: number): object {
    if (phase === "direct") return {};

    const host = this.brightdataHost;
    const port = this.brightdataPort;
    if (!host || !this.brightdataUser || !this.brightdataPass) return {};

    let user = this.brightdataUser;
    if (phase === "proxy_rotating") {
      // Each request uses a different session = different exit IP
      const sessionId = Math.random().toString(36).slice(2, 10);
      user = `${user}-session-${sessionId}`;
    }

    const proxyUrl = `http://${encodeURIComponent(user)}:${encodeURIComponent(this.brightdataPass)}@${host}:${port}`;
    return { httpsAgent: new HttpsProxyAgent(proxyUrl), proxy: false };
  }

  private async log(testId: string, message: string, level: "info" | "warn" | "success" | "error") {
    console.log(`[RateLimitTest:${testId}] ${message}`);
    await this.bus.publish("test:log", { testId, message, level, timestamp: Date.now() });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
