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
  bus: EventBus
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
