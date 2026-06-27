import Dockerode from "dockerode";
import { Queue } from "bullmq";
import type { PrismaClient } from "@prisma/client";
import type { EventBus } from "../events/EventBus";
import type Redis from "ioredis";

const WORKER_IMAGE = process.env.WORKER_IMAGE ?? "ca-bot-v2-worker";
const WORKER_NETWORK = process.env.DOCKER_NETWORK ?? "ca-bot-v2_default";

export class WorkerManager {
  private docker: Dockerode;
  private queue: Queue;
  // accountId → containerId
  private containers = new Map<string, string>();

  constructor(
    private redisUrl: string,
    private db: PrismaClient,
    private bus: EventBus,
    private redis?: Redis
  ) {
    this.docker = new Dockerode({ socketPath: "/var/run/docker.sock" });
    this.queue = new Queue("worker-jobs", { connection: { url: redisUrl } });
  }

  async startWorker(accountId: string) {
    const account = await this.db.account.findUniqueOrThrow({ where: { id: accountId }, include: { proxy: true } });

    if (this.containers.has(accountId)) {
      throw new Error(`Worker for ${accountId} already running`);
    }

    const env = [
      `ACCOUNT_ID=${accountId}`,
      `REDIS_URL=${process.env.REDIS_URL}`,
      `CAPTCHA_BACKEND_URL=${process.env.CAPTCHA_BACKEND_URL}`,
      `INTERNAL_API_KEY=${process.env.INTERNAL_API_KEY}`,
      `GMAIL_USER=${process.env.GMAIL_USER ?? ""}`,
      `GMAIL_APP_PASSWORD=${process.env.GMAIL_APP_PASSWORD ?? ""}`,
    ];
    if (account.proxy) {
      env.push(`PROXY_URL=${account.proxy.url}`);
    }
    // Forward Bright Data ISP proxy config if set — worker builds a fixed-session URL per account
    if (process.env.BRIGHTDATA_ISP_HOST) env.push(`BRIGHTDATA_ISP_HOST=${process.env.BRIGHTDATA_ISP_HOST}`);
    if (process.env.BRIGHTDATA_ISP_PORT) env.push(`BRIGHTDATA_ISP_PORT=${process.env.BRIGHTDATA_ISP_PORT}`);
    if (process.env.BRIGHTDATA_ISP_USER) env.push(`BRIGHTDATA_ISP_USER=${process.env.BRIGHTDATA_ISP_USER}`);
    if (process.env.BRIGHTDATA_ISP_PASS) env.push(`BRIGHTDATA_ISP_PASS=${process.env.BRIGHTDATA_ISP_PASS}`);
    // Forward Bright Data DC rotating proxy config — used for rotating IP rate-limit tests
    if (process.env.BRIGHTDATA_DC_HOST) env.push(`BRIGHTDATA_DC_HOST=${process.env.BRIGHTDATA_DC_HOST}`);
    if (process.env.BRIGHTDATA_DC_PORT) env.push(`BRIGHTDATA_DC_PORT=${process.env.BRIGHTDATA_DC_PORT}`);
    if (process.env.BRIGHTDATA_DC_USER) env.push(`BRIGHTDATA_DC_USER=${process.env.BRIGHTDATA_DC_USER}`);
    if (process.env.BRIGHTDATA_DC_PASS) env.push(`BRIGHTDATA_DC_PASS=${process.env.BRIGHTDATA_DC_PASS}`);
    if (process.env.GROQ_API_KEY)   env.push(`GROQ_API_KEY=${process.env.GROQ_API_KEY}`);
    if (process.env.OPENAI_API_KEY) env.push(`OPENAI_API_KEY=${process.env.OPENAI_API_KEY}`);

    const container = await this.docker.createContainer({
      Image: WORKER_IMAGE,
      Env: env,
      HostConfig: {
        NetworkMode: WORKER_NETWORK,
        ShmSize: 1024 * 1024 * 1024, // 1GB for Chromium
        RestartPolicy: { Name: "no" },
      },
      Labels: { "ca-bot.accountId": accountId },
    });

    await container.start();
    this.containers.set(accountId, container.id);

    await this.db.account.update({ where: { id: accountId }, data: { status: "STARTING" } });
    await this.db.workerSession.create({
      data: { accountId, containerId: container.id, status: "STARTING" },
    });

    await this.bus.publish("worker:started", { accountId, containerId: container.id }, accountId);
    console.log(`[WorkerManager] Started container ${container.id} for account ${accountId}`);
    return container.id;
  }

  async stopWorker(accountId: string) {
    const containerId = this.containers.get(accountId);
    if (!containerId) return;

    const container = this.docker.getContainer(containerId);

    try { await container.stop({ t: 10 }); } catch (err) {
      console.error(`[WorkerManager] Error stopping ${containerId}:`, err);
    }

    // Persist logs before removing the container
    await this.saveLogsToRedis(containerId, accountId);

    try { await container.remove({ force: true }); } catch (err) {
      console.error(`[WorkerManager] Error removing ${containerId}:`, err);
    }

    this.containers.delete(accountId);
    await this.db.account.update({ where: { id: accountId }, data: { status: "IDLE" } });
    await this.db.workerSession.updateMany({
      where: { accountId, endedAt: null },
      data: { status: "STOPPED", endedAt: new Date() },
    });

    await this.bus.publish("worker:stopped", { accountId }, accountId);
  }

  async stopAll() {
    const ids = [...this.containers.keys()];
    await Promise.all(ids.map((id) => this.stopWorker(id)));
  }

  getRunning(): string[] {
    return [...this.containers.keys()];
  }

  getContainerId(accountId: string): string | undefined {
    return this.containers.get(accountId);
  }

  async streamLogs(containerId: string, tail = 200): Promise<NodeJS.ReadableStream> {
    const container = this.docker.getContainer(containerId);
    return container.logs({ follow: true, stdout: true, stderr: true, tail, timestamps: true });
  }

  // Called by HealthMonitor (heartbeat timeout) or immediately on self-reported crash
  async handleDeadWorker(accountId: string) {
    const containerId = this.containers.get(accountId);
    this.containers.delete(accountId); // remove from running map so HealthMonitor skips it

    if (containerId) {
      await this.saveLogsToRedis(containerId, accountId);
      try { await this.docker.getContainer(containerId).remove({ force: true }); } catch {}
    }

    await this.db.account.update({ where: { id: accountId }, data: { status: "ERROR" } }).catch(() => {});
    await this.db.workerSession.updateMany({
      where: { accountId, endedAt: null },
      data: { status: "CRASHED", endedAt: new Date() },
    }).catch(() => {});

    // Only re-publish for silent crashes (HealthMonitor path); self-reported ones already published
    if (containerId) {
      await this.bus.publish("worker:crashed", { accountId, reason: "heartbeat_timeout" }, accountId);
    }
  }

  // ── Log persistence helpers ───────────────────────────────────────────────

  private async captureContainerLogs(containerId: string): Promise<string[]> {
    try {
      // follow: false → dockerode returns a full Buffer (multiplexed: 8-byte header per line)
      const raw = await this.docker.getContainer(containerId).logs({
        follow: false, stdout: true, stderr: true, tail: 500, timestamps: true,
      });

      // Try multiplexed parsing first (TTY=false containers)
      const lines: string[] = [];
      let offset = 0;
      let multiplexed = false;

      while (offset + 8 <= raw.length) {
        const streamType = raw[offset];
        const size = raw.readUInt32BE(offset + 4);
        if (streamType <= 2 && size > 0 && offset + 8 + size <= raw.length) {
          multiplexed = true;
          const line = raw.slice(offset + 8, offset + 8 + size).toString("utf8").trimEnd();
          if (line) lines.push(line);
          offset += 8 + size;
        } else {
          break;
        }
      }

      // Fallback: raw text (TTY=true or non-standard driver)
      if (!multiplexed && raw.length > 0) {
        const text = raw.toString("utf8");
        text.split("\n").forEach(l => { if (l.trim()) lines.push(l); });
      }

      return lines;
    } catch (err) {
      console.error(`[WorkerManager] captureContainerLogs error for ${containerId.slice(0, 12)}:`, err);
      return [];
    }
  }

  async saveLogsToRedis(containerId: string, accountId: string) {
    if (!this.redis) return;
    const lines = await this.captureContainerLogs(containerId);
    console.log(`[WorkerManager] Captured ${lines.length} log lines from ${containerId.slice(0, 12)} for ${accountId}`);
    if (lines.length === 0) return;

    const key = `worker:logs:last:${accountId}`;
    const pipe = this.redis.pipeline();
    pipe.del(key); // replace entirely — no duplicates if called twice
    lines.forEach(l => pipe.rpush(key, l));
    pipe.expire(key, 86400); // 24h TTL
    await pipe.exec().catch(console.error);
  }
}
