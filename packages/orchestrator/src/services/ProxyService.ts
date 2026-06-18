import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import axios from "axios";

export const CreateProxySchema = z.object({
  url: z.string().url(),
  zone: z.string().optional(),
  label: z.string().optional(),
});

const HEALTH_CHECK_URL = "https://api.ipify.org?format=json";
const HEALTH_TIMEOUT_MS = 8000;

export class ProxyService {
  constructor(private db: PrismaClient) {}

  async list() {
    return this.db.proxy.findMany({ include: { _count: { select: { accounts: true } } } });
  }

  async create(data: z.infer<typeof CreateProxySchema>) {
    return this.db.proxy.create({ data });
  }

  async delete(id: string) {
    return this.db.proxy.delete({ where: { id } });
  }

  async checkHealth(proxyId: string): Promise<boolean> {
    const proxy = await this.db.proxy.findUniqueOrThrow({ where: { id: proxyId } });
    try {
      await axios.get(HEALTH_CHECK_URL, {
        proxy: parseProxyUrl(proxy.url),
        timeout: HEALTH_TIMEOUT_MS,
      });
      await this.db.proxy.update({
        where: { id: proxyId },
        data: { status: "ACTIVE", lastChecked: new Date(), failCount: 0 },
      });
      return true;
    } catch {
      const updated = await this.db.proxy.update({
        where: { id: proxyId },
        data: { status: "DEAD", lastChecked: new Date(), failCount: { increment: 1 } },
      });
      console.warn(`[ProxyService] Proxy ${proxyId} health check failed (fails: ${updated.failCount})`);
      return false;
    }
  }

  async runHealthChecks() {
    const proxies = await this.db.proxy.findMany({ where: { status: { not: "DEAD" } } });
    await Promise.allSettled(proxies.map((p) => this.checkHealth(p.id)));
  }

  async getAvailableProxy(): Promise<string | null> {
    const proxy = await this.db.proxy.findFirst({
      where: { status: "ACTIVE", accounts: { none: {} } },
    });
    return proxy?.id ?? null;
  }
}

function parseProxyUrl(url: string) {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port) || 8080,
    auth:
      u.username
        ? { username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) }
        : undefined,
    protocol: u.protocol.replace(":", "") as "http" | "https",
  };
}
