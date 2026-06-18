import Redis from "ioredis";

export class EventBus {
  private pub: Redis;

  constructor(redisUrl: string) {
    this.pub = new Redis(redisUrl);
  }

  async publish(type: string, payload: Record<string, unknown>) {
    const event = { type, payload, ts: Date.now() };
    await this.pub.publish(`event:${type}`, JSON.stringify(event));
    await this.pub.publish("event:*", JSON.stringify(event));
  }

  async disconnect() {
    await this.pub.quit();
  }
}
