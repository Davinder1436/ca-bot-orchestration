import type Redis from "ioredis";

const TTL_SECS = 30 * 24 * 60 * 60; // 30 days

export class RunLogger {
  readonly runId: string;

  constructor(private redis: Redis, private accountId: string) {
    this.runId = `prun-${Date.now()}`;
  }

  async init(metadata: Record<string, unknown> = {}) {
    const meta = {
      runId: this.runId,
      accountId: this.accountId,
      startedAt: Date.now(),
      status: "running",
      ...metadata,
    };
    const pipe = this.redis.pipeline();
    pipe.set(`run:meta:${this.runId}`, JSON.stringify(meta), "EX", TTL_SECS);
    pipe.zadd(`run:index:${this.accountId}`, Date.now(), this.runId);
    pipe.expire(`run:index:${this.accountId}`, TTL_SECS);
    await pipe.exec();
    console.log(`[RunLogger] Run ${this.runId} started for ${this.accountId}`);
  }

  async log(message: string, level: "info" | "warn" | "error" = "info") {
    const entry = JSON.stringify({ ts: Date.now(), level, message });
    await this.redis.rpush(`run:logs:${this.runId}`, entry);
    await this.redis.expire(`run:logs:${this.runId}`, TTL_SECS);
  }

  async logTick(tick: Record<string, unknown>) {
    const entry = JSON.stringify(tick);
    await this.redis.rpush(`run:ticks:${this.runId}`, entry);
    await this.redis.expire(`run:ticks:${this.runId}`, TTL_SECS);
  }

  async finalize(status: "stopped" | "crashed", error?: string) {
    const raw = await this.redis.get(`run:meta:${this.runId}`);
    const meta = raw
      ? JSON.parse(raw)
      : { runId: this.runId, accountId: this.accountId, startedAt: Date.now() };
    meta.status = status;
    meta.endedAt = Date.now();
    if (error) meta.error = error;
    await this.redis.set(`run:meta:${this.runId}`, JSON.stringify(meta), "EX", TTL_SECS);
    console.log(`[RunLogger] Run ${this.runId} finalized: ${status}`);
  }
}
