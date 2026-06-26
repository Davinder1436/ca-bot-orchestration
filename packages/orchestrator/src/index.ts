import express from "express";
import cors from "cors";
import { createServer } from "http";
import { Server as SocketServer } from "socket.io";
import { PrismaClient } from "@prisma/client";
import Redis from "ioredis";
import { EventBus } from "./events/EventBus";
import { WorkerManager } from "./workers/WorkerManager";
import { HealthMonitor } from "./workers/HealthMonitor";
import { ProxyService } from "./services/ProxyService";
import { createRouter } from "./api/routes";

const PORT = parseInt(process.env.PORT ?? "3000");
const REDIS_URL = process.env.REDIS_URL!;

async function main() {
  const db = new PrismaClient();
  await db.$connect();
  console.log("[Orchestrator] DB connected");

  const redis = new Redis(REDIS_URL, { lazyConnect: true });
  await redis.connect();
  console.log("[Orchestrator] Redis connected");

  const bus = new EventBus(REDIS_URL);
  await bus.connect();

  const workerManager = new WorkerManager(REDIS_URL, db, bus, redis);
  const healthMonitor = new HealthMonitor(redis, db, workerManager);
  const proxyService = new ProxyService(db);

  // Express app
  const app = express();
  app.use(cors({ origin: "*" }));
  app.use(express.json({ limit: "1mb" }));
  app.use("/api", createRouter(db, workerManager, bus, redis));

  const httpServer = createServer(app);
  const io = new SocketServer(httpServer, { cors: { origin: "*" } });

  // Forward all bus events to connected dashboard clients
  bus.subscribe("*", (event) => {
    io.emit("event", event);
    // Skip DB persistence for high-frequency poll ticks (visualised in-memory only)
    if ((event.type as string).startsWith("poll:") || (event.type as string).startsWith("test:")) {
      return;
    }
    db.event.create({ data: { type: event.type, accountId: event.accountId, payload: event.payload as object } })
      .catch(console.error);
  });

  // Heartbeat from workers arrives via Redis; update DB + broadcast
  bus.subscribe("worker:heartbeat", async (event) => {
    const { accountId } = event.payload as { accountId: string };
    await redis.set(`worker:heartbeat:${accountId}`, Date.now().toString(), "EX", 120);
    await db.workerSession.updateMany({
      where: { accountId, endedAt: null },
      data: { lastHeartbeat: new Date() },
    });
  });

  // Self-reported crash — save logs immediately instead of waiting 90s for HealthMonitor
  bus.subscribe("worker:crashed", async (event) => {
    const p = event.payload as { accountId: string; reason?: string };
    if (p.reason === "heartbeat_timeout") return; // already handled by HealthMonitor path
    // 800ms delay: let the container finish flushing its final log lines to Docker
    await new Promise(r => setTimeout(r, 800));
    await workerManager.handleDeadWorker(p.accountId);
  });

  // Worker state changes → update account status
  bus.subscribe("worker:state", async (event) => {
    const { accountId, state } = event.payload as { accountId: string; state: string };
    await db.account.update({ where: { id: accountId }, data: { status: state } }).catch(() => {});
  });

  // Job captured → persist capture record
  bus.subscribe("job:captured", async (event) => {
    const p = event.payload as {
      accountId: string; jobId: string; scheduleId: string;
      jobTitle?: string; location?: string; applyUrl?: string;
    };
    await db.jobCapture.create({
      data: {
        accountId: p.accountId,
        jobId: p.jobId,
        scheduleId: p.scheduleId,
        jobTitle: p.jobTitle,
        location: p.location,
        applyUrl: p.applyUrl,
      },
    }).catch(console.error);
  });

  io.on("connection", (socket) => {
    console.log(`[Orchestrator] Dashboard client connected: ${socket.id}`);
    socket.on("disconnect", () => {
      console.log(`[Orchestrator] Dashboard client disconnected: ${socket.id}`);
    });
  });

  healthMonitor.start();

  // Proxy health check every 5 minutes
  setInterval(() => proxyService.runHealthChecks(), 5 * 60 * 1000);

  httpServer.listen(PORT, () => {
    console.log(`[Orchestrator] Listening on :${PORT}`);
  });

  const shutdown = async () => {
    console.log("[Orchestrator] Shutting down...");
    healthMonitor.stop();
    await workerManager.stopAll();
    await bus.disconnect();
    await redis.quit();
    await db.$disconnect();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => { console.error(err); process.exit(1); });
