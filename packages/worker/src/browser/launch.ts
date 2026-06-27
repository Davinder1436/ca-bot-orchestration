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

// Chrome's --proxy-server flag does not accept credentials in the URL.
// Parse the URL and pass credentials via Playwright's native proxy option instead.
export function parseProxyUrl(url: string): { server: string; username?: string; password?: string } {
  const parsed = new URL(url);
  const server = `${parsed.protocol}//${parsed.host}`;
  const username = parsed.username ? decodeURIComponent(parsed.username) : undefined;
  const password = parsed.password ? decodeURIComponent(parsed.password) : undefined;
  return { server, ...(username && { username }), ...(password && { password }) };
}

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
    // Load our minimal extension so content.js exposes window.__captureTab().
    // captureVisibleTab() gives GPU-composited output with all 9 captcha tiles rendered,
    // unlike page.screenshot() which misses lazy-loaded rows 2-3 in headless mode.
    "--load-extension=/app/captcha-extension",
    "--disable-extensions-except=/app/captcha-extension",
  ];

  const browser = await chromium.launch({
    headless: false, // extensions require headed mode; Xvfb provides the display in Docker
    args,
    proxy: opts.proxyUrl ? parseProxyUrl(opts.proxyUrl) : undefined,
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

  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, "languages", { get: () => ["en-CA", "en"] });
    Object.defineProperty(window, "chrome", {
      writable: true,
      value: { runtime: {}, loadTimes: () => {}, csi: () => {}, app: {} },
    });
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
