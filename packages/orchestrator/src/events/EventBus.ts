import Redis from "ioredis";

export type EventType =
  | "job:captured"
  | "session:expired"
  | "worker:crashed"
  | "worker:started"
  | "worker:stopped"
  | "worker:heartbeat"
  | "worker:state"
  | "proxy:failed"
  | "proxy:reassigned"
  | "account:banned"
  | "captcha:solved"
  | "captcha:failed"
  | "daily:summary";

export interface BusEvent {
  type: EventType;
  accountId?: string;
  payload: Record<string, unknown>;
  ts: number;
}

export class EventBus {
  private pub: Redis;
  private sub: Redis;
  private handlers = new Map<string, ((e: BusEvent) => void)[]>();

  constructor(redisUrl: string) {
    this.pub = new Redis(redisUrl, { lazyConnect: true });
    this.sub = new Redis(redisUrl, { lazyConnect: true });
  }

  async connect() {
    await this.pub.connect();
    await this.sub.connect();
    this.sub.on("message", (channel, raw) => {
      try {
        const event: BusEvent = JSON.parse(raw);
        const list = this.handlers.get(channel) ?? [];
        list.forEach((h) => h(event));
        // wildcard listeners
        const all = this.handlers.get("*") ?? [];
        all.forEach((h) => h(event));
      } catch {}
    });
  }

  async publish(type: EventType, payload: Record<string, unknown>, accountId?: string) {
    const event: BusEvent = { type, accountId, payload, ts: Date.now() };
    await this.pub.publish(`event:${type}`, JSON.stringify(event));
    // Also publish to a single all-events channel for dashboard
    await this.pub.publish("event:*", JSON.stringify(event));
  }

  subscribe(type: EventType | "*", handler: (e: BusEvent) => void) {
    const channel = type === "*" ? "event:*" : `event:${type}`;
    if (!this.handlers.has(channel)) {
      this.handlers.set(channel, []);
      this.sub.subscribe(channel);
    }
    this.handlers.get(channel)!.push(handler);
  }

  async disconnect() {
    await this.pub.quit();
    await this.sub.quit();
  }
}
