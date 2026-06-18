import Redis from "ioredis";

const OTP_TIMEOUT_MS = 90_000;

let redis: Redis | null = null;

function getRedis(): Redis {
  if (!redis) {
    redis = new Redis(process.env.REDIS_URL!);
  }
  return redis;
}

export async function waitForOtp(accountEmail: string, accountId: string): Promise<string> {
  const r = getRedis();
  const channel = `otp:${accountEmail.toLowerCase()}`;

  console.log(`[OTP:${accountEmail}] Waiting on Redis channel ${channel}`);

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      sub.unsubscribe(channel);
      sub.quit();
      reject(new Error(`OTP timeout for ${accountEmail} after ${OTP_TIMEOUT_MS}ms`));
    }, OTP_TIMEOUT_MS);

    const sub = r.duplicate();
    sub.subscribe(channel, (err) => {
      if (err) {
        clearTimeout(timeout);
        reject(err);
        return;
      }
    });

    sub.on("message", (_ch: string, otp: string) => {
      clearTimeout(timeout);
      sub.unsubscribe(channel);
      sub.quit();
      console.log(`[OTP:${accountEmail}] Received OTP`);
      resolve(otp);
    });
  });
}
