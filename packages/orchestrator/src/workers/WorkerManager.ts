import Dockerode from "dockerode";
import { Queue } from "bullmq";
import type { PrismaClient } from "@prisma/client";
import type { EventBus } from "../events/EventBus";

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
    private bus: EventBus
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
    ];
    if (account.proxy) {
      env.push(`PROXY_URL=${account.proxy.url}`);
    }

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

    try {
      const container = this.docker.getContainer(containerId);
      await container.stop({ t: 10 });
      await container.remove();
    } catch (err) {
      console.error(`[WorkerManager] Error stopping ${containerId}:`, err);
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

  // Called by HealthMonitor when a container is confirmed dead
  async handleDeadWorker(accountId: string) {
    this.containers.delete(accountId);
    await this.db.account.update({ where: { id: accountId }, data: { status: "ERROR" } });
    await this.db.workerSession.updateMany({
      where: { accountId, endedAt: null },
      data: { status: "CRASHED", endedAt: new Date() },
    });
    await this.bus.publish("worker:crashed", { accountId, reason: "heartbeat_timeout" }, accountId);
  }
}
