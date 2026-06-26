import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import type { WorkerManager } from "../workers/WorkerManager";
import {
  AccountService,
  CreateAccountSchema,
  UpdateAccountSchema,
} from "../services/AccountService";
import { ProxyService, CreateProxySchema } from "../services/ProxyService";
import type { PrismaClient } from "@prisma/client";
import type { EventBus } from "../events/EventBus";
import type Redis from "ioredis";

function validate<T>(schema: z.ZodSchema<T>) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      res.status(400).json({ error: result.error.flatten() });
      return;
    }
    req.body = result.data;
    next();
  };
}

function wrap(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

export function createRouter(
  db: PrismaClient,
  workerManager: WorkerManager,
  bus: EventBus,
  redis: Redis
): Router {
  const router = Router();
  const accounts = new AccountService(db);
  const proxies = new ProxyService(db);

  // ── Accounts ─────────────────────────────────────────────────
  router.get("/accounts", wrap(async (_req, res) => { res.json(await accounts.list()); }));
  router.get("/accounts/:id", wrap(async (req, res) => { res.json(await accounts.get(req.params.id)); }));
  router.post("/accounts", validate(CreateAccountSchema), wrap(async (req, res) => {
    res.status(201).json(await accounts.create(req.body));
  }));
  router.patch("/accounts/:id", validate(UpdateAccountSchema), wrap(async (req, res) => {
    res.json(await accounts.update(req.params.id, req.body));
  }));
  router.delete("/accounts/:id", wrap(async (req, res) => {
    await accounts.delete(req.params.id);
    res.status(204).end();
  }));

  // ── Workers ───────────────────────────────────────────────────
  router.post("/workers/:accountId/start", wrap(async (req, res) => {
    const containerId = await workerManager.startWorker(req.params.accountId);
    res.json({ containerId });
  }));
  router.post("/workers/:accountId/stop", wrap(async (req, res) => {
    await workerManager.stopWorker(req.params.accountId);
    res.status(204).end();
  }));
  router.get("/workers", (_req, res) => {
    res.json({ running: workerManager.getRunning() });
  });

  router.get("/workers/:accountId/details", wrap(async (req, res) => {
    const { accountId } = req.params;
    const [account, sessions, recentEvents] = await Promise.all([
      db.account.findUnique({
        where: { id: accountId },
        include: { proxy: true, _count: { select: { captures: true } } },
      }),
      db.workerSession.findMany({
        where: { accountId },
        orderBy: { startedAt: "desc" },
        take: 5,
      }),
      db.event.findMany({
        where: { accountId },
        orderBy: { createdAt: "desc" },
        take: 30,
      }),
    ]);
    if (!account) { res.status(404).json({ error: "Account not found" }); return; }
    res.json({ account, containerId: workerManager.getContainerId(accountId) ?? null, sessions, recentEvents });
  }));

  // SSE: live container logs — must NOT use wrap() as response is streaming
  router.get("/workers/:accountId/logs", async (req, res) => {
    const containerId = workerManager.getContainerId(req.params.accountId);
    if (!containerId) {
      res.status(404).json({ error: "No running container for this account" });
      return;
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no"); // disable nginx buffering
    res.flushHeaders();

    const send = (data: object) => {
      try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch (_) { /* client gone */ }
    };

    try {
      const stream = await workerManager.streamLogs(containerId, 200);

      let buf = Buffer.alloc(0);
      stream.on("data", (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        // Parse Docker multiplexed stream (8-byte header: [type(1), 0,0,0, size(4)])
        while (buf.length >= 8) {
          const size = buf.readUInt32BE(4);
          if (buf.length < 8 + size) break;
          const line = buf.slice(8, 8 + size).toString("utf8").trimEnd();
          if (line) send({ line });
          buf = buf.slice(8 + size);
        }
      });
      stream.on("error", () => res.end());
      stream.on("end", () => { send({ eof: true }); res.end(); });
      req.on("close", () => { try { (stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.(); } catch (_) {} });
    } catch (err) {
      send({ error: String(err) });
      res.end();
    }
  });

  // ── Proxies ───────────────────────────────────────────────────
  router.get("/proxies", wrap(async (_req, res) => { res.json(await proxies.list()); }));
  router.post("/proxies", validate(CreateProxySchema), wrap(async (req, res) => {
    res.status(201).json(await proxies.create(req.body));
  }));
  router.delete("/proxies/:id", wrap(async (req, res) => {
    await proxies.delete(req.params.id);
    res.status(204).end();
  }));
  router.post("/proxies/:id/check", wrap(async (req, res) => {
    const ok = await proxies.checkHealth(req.params.id);
    res.json({ healthy: ok });
  }));

  // ── Jobs ──────────────────────────────────────────────────────
  router.get("/jobs", wrap(async (req, res) => {
    const { accountId, limit = "50" } = req.query as Record<string, string>;
    const where = accountId ? { accountId } : {};
    const data = await db.jobCapture.findMany({
      where,
      orderBy: { capturedAt: "desc" },
      take: parseInt(limit),
      include: { account: { select: { email: true, country: true } } },
    });
    res.json(data);
  }));

  // ── Events ────────────────────────────────────────────────────
  router.get("/events", wrap(async (req, res) => {
    const { limit = "100", type, accountId } = req.query as Record<string, string>;
    const data = await db.event.findMany({
      where: { ...(type && { type }), ...(accountId && { accountId }) },
      orderBy: { createdAt: "desc" },
      take: parseInt(limit),
    });
    res.json(data);
  }));

  // ── Log history (persisted to Redis on stop/crash) ───────────
  router.get("/workers/:accountId/logs/history", wrap(async (req, res) => {
    const lines = await redis.lrange(`worker:logs:last:${req.params.accountId}`, 0, -1);
    res.json(lines);
  }));

  // ── Browser console history ───────────────────────────────────
  router.get("/workers/:accountId/console/history", wrap(async (req, res) => {
    const raw = await redis.lrange(`worker:console:log:${req.params.accountId}`, 0, -1);
    const msgs = raw
      .map(s => { try { return JSON.parse(s); } catch { return null; } })
      .filter(Boolean);
    res.json(msgs);
  }));

  // ── Browser debug: screenshot (polled) ───────────────────────
  router.get("/workers/:accountId/screenshot", wrap(async (req, res) => {
    const data = await redis.get(`worker:screenshot:${req.params.accountId}`);
    if (!data) { res.status(404).json({ error: "No screenshot available" }); return; }
    res.json({ image: data, ts: Date.now() });
  }));

  // ── Browser debug: console log stream (SSE) ───────────────────
  router.get("/workers/:accountId/console/stream", async (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const sub = redis.duplicate();
    await sub.subscribe(`worker:console:${req.params.accountId}`);
    sub.on("message", (_ch, raw) => {
      try { res.write(`data: ${raw}\n\n`); } catch (_) {}
    });
    req.on("close", async () => {
      await sub.unsubscribe().catch(() => {});
      await sub.quit().catch(() => {});
    });
  });

  // ── Polling rate control ──────────────────────────────────────
  // PATCH /workers/:accountId/polling-rate   body: { intervalMs: number }
  router.patch("/workers/:accountId/polling-rate", wrap(async (req, res) => {
    const { accountId } = req.params;
    const { intervalMs } = req.body as { intervalMs: unknown };
    if (!Number.isInteger(intervalMs) || (intervalMs as number) < 500 || (intervalMs as number) > 60_000) {
      res.status(400).json({ error: "intervalMs must be an integer 500–60000" });
      return;
    }
    await redis.publish(`poller:cmd:${accountId}`, JSON.stringify({ type: "setInterval", intervalMs }));
    res.json({ ok: true, intervalMs });
  }));

  // ── Worker token (used by rate-limit test page) ───────────────
  router.get("/workers/:accountId/token", wrap(async (req, res) => {
    const token = await redis.get(`worker:token:${req.params.accountId}`);
    if (!token) { res.status(404).json({ error: "No token stored for this worker (worker not running or token expired)" }); return; }
    res.json({ token });
  }));

  // ── Rate-limit tests (run inside the worker's authenticated browser) ─────────
  // The worker's browser has session cookies — bare HTTP from the orchestrator
  // always 403s. Tests are dispatched to the worker via Redis and results stream
  // back via the event bus → socket.io.
  router.post("/tests/rate-limit/start", wrap(async (req, res) => {
    const { accountId, jobId, rpms } = req.body as {
      accountId?: string;
      jobId?: string;
      rpms?: number[];
    };

    if (!accountId) { res.status(400).json({ error: "accountId required" }); return; }
    if (!jobId) { res.status(400).json({ error: "jobId required" }); return; }

    const running = workerManager.getRunning();
    if (!running.includes(accountId)) {
      res.status(400).json({ error: "No running worker for this account — start the worker first so it has an authenticated browser session" });
      return;
    }

    const testId = `rlt-${Date.now()}`;
    const testMeta = {
      testId,
      accountId,
      jobId,
      startedAt: Date.now(),
      status: "running",
    };
    const TEST_TTL = 30 * 24 * 60 * 60; // 30 days
    await redis.set(`test:meta:${testId}`, JSON.stringify(testMeta), "EX", TEST_TTL);
    await redis.zadd(`test:index:${accountId}`, Date.now(), testId);
    await redis.expire(`test:index:${accountId}`, TEST_TTL);

    // Dispatch to worker's Redis channel — worker runs it inside its browser
    await redis.publish(`worker:test-cmd:${accountId}`, JSON.stringify({
      testId,
      jobId,
      rpms: rpms ?? [5, 10, 20, 30, 40, 50, 60, 80, 100],
    }));

    res.json({ testId });
  }));

  router.post("/tests/rate-limit/stop", wrap(async (req, res) => {
    // Currently no cancellation for in-worker tests — the test respects the
    // natural end of the rpm escalation, or the worker can be restarted.
    res.json({ ok: true, note: "Worker-based tests run to completion; restart the worker to abort" });
  }));

  // ── Polling run history (stored by RunLogger in the worker) ──────────────
  router.get("/runs", wrap(async (req, res) => {
    const { accountId } = req.query as Record<string, string>;
    if (!accountId) { res.status(400).json({ error: "accountId required" }); return; }
    const runIds = await redis.zrevrange(`run:index:${accountId}`, 0, 49);
    if (runIds.length === 0) { res.json([]); return; }
    const metas = await Promise.all(
      runIds.map(async (id) => {
        const raw = await redis.get(`run:meta:${id}`);
        return raw ? JSON.parse(raw) : { runId: id, status: "unknown" };
      })
    );
    res.json(metas);
  }));

  router.get("/runs/:runId/logs", wrap(async (req, res) => {
    const raw = await redis.lrange(`run:logs:${req.params.runId}`, 0, -1);
    res.json(raw.map(l => { try { return JSON.parse(l); } catch { return { message: l }; } }));
  }));

  router.get("/runs/:runId/ticks", wrap(async (req, res) => {
    const raw = await redis.lrange(`run:ticks:${req.params.runId}`, 0, -1);
    res.json(raw.map(l => { try { return JSON.parse(l); } catch { return { raw: l }; } }));
  }));

  router.delete("/runs/:runId", wrap(async (req, res) => {
    const { runId } = req.params;
    const rawMeta = await redis.get(`run:meta:${runId}`);
    const meta = rawMeta ? JSON.parse(rawMeta) : null;
    const pipe = redis.pipeline();
    pipe.del(`run:meta:${runId}`, `run:logs:${runId}`, `run:ticks:${runId}`);
    if (meta?.accountId) pipe.zrem(`run:index:${meta.accountId}`, runId);
    await pipe.exec();
    res.status(204).end();
  }));

  // ── Test run history ──────────────────────────────────────────────────────
  router.get("/test-runs", wrap(async (req, res) => {
    const { accountId } = req.query as Record<string, string>;
    if (!accountId) { res.status(400).json({ error: "accountId required" }); return; }
    const testIds = await redis.zrevrange(`test:index:${accountId}`, 0, 49);
    if (testIds.length === 0) { res.json([]); return; }
    const metas = await Promise.all(
      testIds.map(async (id) => {
        const raw = await redis.get(`test:meta:${id}`);
        return raw ? JSON.parse(raw) : { testId: id, status: "unknown" };
      })
    );
    res.json(metas);
  }));

  router.get("/test-runs/:testId/logs", wrap(async (req, res) => {
    const raw = await redis.lrange(`test:logs:${req.params.testId}`, 0, -1);
    res.json(raw.map(l => { try { return JSON.parse(l); } catch { return { message: l }; } }));
  }));

  router.get("/test-runs/:testId/results", wrap(async (req, res) => {
    const raw = await redis.get(`test:results:${req.params.testId}`);
    if (!raw) { res.status(404).json({ error: "Results not found — test may still be running" }); return; }
    res.json(JSON.parse(raw));
  }));

  router.delete("/test-runs/:testId", wrap(async (req, res) => {
    const { testId } = req.params;
    const rawMeta = await redis.get(`test:meta:${testId}`);
    const meta = rawMeta ? JSON.parse(rawMeta) : null;
    const pipe = redis.pipeline();
    pipe.del(`test:meta:${testId}`, `test:logs:${testId}`, `test:results:${testId}`);
    if (meta?.accountId) pipe.zrem(`test:index:${meta.accountId}`, testId);
    await pipe.exec();
    res.status(204).end();
  }));

  // ── Health ────────────────────────────────────────────────────
  router.get("/health", (_req, res) => {
    res.json({ status: "ok", ts: Date.now(), workers: workerManager.getRunning().length });
  });

  // Global error handler
  router.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error("[API Error]", err.message);
    res.status(500).json({ error: err.message });
  });

  return router;
}
