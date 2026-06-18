import { chromium, type Browser, type BrowserContext } from "playwright";

interface LaunchOptions {
  proxyUrl?: string;
  userAgent?: string;
  viewport?: { width: number; height: number };
  timezone?: string;
}

// Realistic UA pool — pick consistently per account (index by accountId hash)
const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
];

const VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1440, height: 900 },
  { width: 1366, height: 768 },
  { width: 1536, height: 864 },
];

export async function launchBrowser(opts: LaunchOptions = {}): Promise<Browser> {
  const args = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-blink-features=AutomationControlled",
    "--disable-infobars",
    "--window-position=0,0",
    "--ignore-certificate-errors",
    "--ignore-certificate-errors-spki-list",
  ];

  if (opts.proxyUrl) {
    args.push(`--proxy-server=${opts.proxyUrl}`);
  }

  const browser = await chromium.launch({
    headless: true,
    args,
    executablePath: process.env.CHROMIUM_PATH,
  });

  return browser;
}

export async function createContext(browser: Browser, opts: LaunchOptions = {}): Promise<BrowserContext> {
  const ua = opts.userAgent ?? USER_AGENTS[0];
  const vp = opts.viewport ?? VIEWPORTS[0];

  const context = await browser.newContext({
    userAgent: ua,
    viewport: vp,
    locale: "en-CA",
    timezoneId: opts.timezone ?? "America/Toronto",
    permissions: [],
    ignoreHTTPSErrors: false,
    extraHTTPHeaders: {
      "Accept-Language": "en-CA,en;q=0.9",
    },
  });

  // Stealth: override navigator.webdriver + plugins
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, "languages", { get: () => ["en-CA", "en"] });
    // Randomize canvas fingerprint slightly
    const origGetContext = HTMLCanvasElement.prototype.getContext;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (HTMLCanvasElement.prototype as any).getContext = function (type: string, ...args: unknown[]) {
      const ctx = origGetContext.apply(this, [type, ...args] as Parameters<typeof origGetContext>);
      if (type === "2d" && ctx) {
        const ctx2d = ctx as CanvasRenderingContext2D;
        const orig = ctx2d.getImageData.bind(ctx2d);
        ctx2d.getImageData = function (x: number, y: number, w: number, h: number) {
          const data = orig(x, y, w, h);
          for (let i = 0; i < data.data.length; i += 100) {
            data.data[i] ^= 1;
          }
          return data;
        };
      }
      return ctx;
    };
  });

  return context;
}

export function pickUAIndex(accountId: string): number {
  let hash = 0;
  for (let i = 0; i < accountId.length; i++) {
    hash = (hash << 5) - hash + accountId.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash) % USER_AGENTS.length;
}

export { USER_AGENTS, VIEWPORTS };
