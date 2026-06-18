import type Redis from "ioredis";
import type { WorkerManager } from "./WorkerManager";
import type { PrismaClient } from "@prisma/client";

const HEARTBEAT_TTL_MS = 90_000; // 3 missed × 30s
const CHECK_INTERVAL_MS = 30_000;

export class HealthMonitor {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private redis: Redis,
    private db: PrismaClient,
    private workerManager: WorkerManager
  ) {}

  start() {
    this.timer = setInterval(() => this.check(), CHECK_INTERVAL_MS);
    console.log("[HealthMonitor] Started");
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  private async check() {
    const running = this.workerManager.getRunning();
    for (const accountId of running) {
      const key = `worker:heartbeat:${accountId}`;
      const last = await this.redis.get(key);
      if (!last) {
        console.warn(`[HealthMonitor] No heartbeat key for ${accountId} — may just have started`);
        continue;
      }
      const age = Date.now() - Number(last);
      if (age > HEARTBEAT_TTL_MS) {
        console.error(`[HealthMonitor] Worker ${accountId} dead (${age}ms since heartbeat) — handling`);
        await this.workerManager.handleDeadWorker(accountId);
      }
    }

    // Also check sessions that show RUNNING but have no container
    const runningSessions = await this.db.workerSession.findMany({
      where: { status: { in: ["STARTING", "RUNNING"] }, endedAt: null },
    });
    for (const session of runningSessions) {
      if (!running.includes(session.accountId)) {
        await this.db.workerSession.update({
          where: { id: session.id },
          data: { status: "ORPHANED", endedAt: new Date() },
        });
      }
    }
  }
}
