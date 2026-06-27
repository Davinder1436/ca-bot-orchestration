import type { BrowserContext, Page } from "playwright";
import { waitForOtp } from "./otp-waiter";
import { solveCaptchaOnPage } from "./captcha";

export interface LoginCredentials {
  email: string;
  pin: string;
  country: "CA" | "US";
  accountId: string;
}

const DOMAIN = (country: "CA" | "US") =>
  country === "CA" ? "hiring.amazon.ca" : "hiring.amazon.com";

export async function login(context: BrowserContext, creds: LoginCredentials): Promise<string> {
  const page = await context.newPage();
  const domain = DOMAIN(creds.country);
  const loginUrl = `https://${domain}/app#/login`;

  console.log(`[Login:${creds.email}] Navigating to login page`);
  await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });

  if (await isCloudFrontBlocked(page)) {
    throw new Error(`[Login] CloudFront 403 — IP/session blocked by Amazon WAF. Rotate proxy or wait before retrying.`);
  }

  // Wait for consent/cookie modal and dismiss it
  await dismissModal(page, 4_000);
  await selectCountry(page, creds.country);

  // Fill email
  const emailSel = await waitForAny(page, [
    'input[data-test-id="input-test-id-login"]',
    'input[name="login EmailId"]',
    'input[aria-label="Email or mobile number"]',
    'input[type="email"]',
  ], 15_000);
  if (!emailSel) throw new Error("Email input not found");

  console.log(`[Login:${creds.email}] Filling email`);
  await fastFill(page, emailSel, creds.email);
  await ms(300);

  // Dismiss any modal that appeared while waiting for email field
  await dismissModal(page, 500);

  const emailBtn = await clickFirst(page, [
    'button[data-test-id="button-continue"]',
    'button:has-text("Continue")',
    'button[type="submit"]',
  ]);
  console.log(`[Login:${creds.email}] Email Continue: ${emailBtn}`);
  await ms(500);

  // Drive remaining steps: PIN → Send code → CAPTCHA → OTP
  await driveLoginSteps(page, creds);

  console.log(`[Login:${creds.email}] Login successful`);

  // Wait for the SPA to finish writing auth state after redirect
  await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});
  await ms(500);

  const token = await extractAccessToken(page);
  if (!token) throw new Error("Could not extract access token after login");
  console.log(`[Login:${creds.email}] Token extracted (${token.slice(0, 20)}…)`);
  return token;
}

// ─── Step driver ─────────────────────────────────────────────────────────────
// Handles the post-email sequence in order:
//   (optional PIN) → Send verification code → CAPTCHA → OTP → jobSearch

const PIN_SELECTORS = [
  'input[data-test-id="input-test-id-pin"]',
  'input[type="password"]',
  'input[name="password"]',
  'input[data-test-id*="pin"]',
  'input[data-test-id*="password"]',
  'input[aria-label*="PIN"]',
  'input[aria-label*="pin"]',
  'input[aria-label*="Password"]',
  'input[aria-label*="password"]',
];
const OTP_SELECTORS = [
  'input[data-test-id="input-test-id-otp"]',
  'input[data-test-id*="otp"]',
  'input[data-test-id*="verification"]',
  'input[data-test-id*="code"]',
  'input[type="tel"][maxlength="6"]',
  'input[maxlength="6"]',
];
const SUBMIT_SELECTORS = [
  'button[data-test-id="button-sign-in"]',
  'button[data-test-id="button-continue"]',
  'button:has-text("Sign in")',
  'button:has-text("Continue")',
  'button:has-text("Submit")',
  'button:has-text("Verify")',
  'button[type="submit"]',
];
const SEND_CODE_SELECTORS = [
  'button[data-test-id="button-send-verification-code"]',
  'button[data-test-id="button-send-otp"]',
  'button[data-test-id="button-sendCode"]',
  'button:has-text("Send verification code")',
  'button:has-text("Send code")',
  'button:has-text("Send Code")',
];

async function driveLoginSteps(page: Page, creds: LoginCredentials) {
  let pinDone = false;
  let sendCodeDone = false;
  const deadline = Date.now() + 120_000;

  while (Date.now() < deadline) {
    if (page.url().includes("jobSearch")) return;

    if (await isCloudFrontBlocked(page)) {
      throw new Error(`[Login] CloudFront 403 mid-flow — IP/session blocked by Amazon WAF. Rotate proxy or wait before retrying.`);
    }

    // Always dismiss any modal before attempting anything
    await dismissModal(page, 500);

    // ── CAPTCHA — only possible AFTER "Send verification code" is clicked ─────
    // (Amazon preloads "Let's confirm you are human" text in shadow DOM earlier,
    //  so gating on sendCodeDone prevents false positives on the code-selection screen)
    if (sendCodeDone && await hasCaptchaHeading(page)) {
      console.log(`[Login:${creds.email}] CAPTCHA detected — solving`);
      await solveCaptchaOnPage(page, creds.email); // throws after 3 failed attempts
      console.log(`[Login:${creds.email}] CAPTCHA solved`);
      await ms(500);
      continue;
    }

    // ── PIN — skip if "Send verification code" is already visible ─────────────
    if (!pinDone) {
      // If Send code button visible, this account has no PIN step
      const sendCodeVisible = await waitForAny(page, SEND_CODE_SELECTORS, 300);
      if (sendCodeVisible) {
        console.log(`[Login:${creds.email}] No PIN step — Send code button visible`);
        pinDone = true;
        continue;
      }
      const pinSel = await waitForAny(page, PIN_SELECTORS, 1_000);
      if (pinSel) {
        console.log(`[Login:${creds.email}] PIN field — filling`);
        await fastFill(page, pinSel, creds.pin);
        await ms(300);
        await dismissModal(page, 300);
        const sub = await clickFirst(page, SUBMIT_SELECTORS);
        console.log(`[Login:${creds.email}] PIN submitted via: ${sub}`);
        pinDone = true;
        await ms(500);
        continue;
      }
    }

    // ── Send verification code ────────────────────────────────────────────────
    if (pinDone && !sendCodeDone) {
      const sendCode = await clickFirst(page, SEND_CODE_SELECTORS);
      if (sendCode) {
        console.log(`[Login:${creds.email}] Send-code clicked: ${sendCode}`);
        sendCodeDone = true;
        await ms(500);
        continue;
      }
    }

    // ── OTP (only after Send code to avoid matching PIN field) ────────────────
    if (sendCodeDone) {
      const otpSel = await waitForAny(page, OTP_SELECTORS, 1_000);
      if (otpSel) {
        const otpEl = page.locator(otpSel).first();
        const isEnabled = await otpEl.isEnabled({ timeout: 300 }).catch(() => false);
        const currentVal = await otpEl.inputValue().catch(() => "");

        // Input disabled or already filled = Amazon is either processing the submission
        // or showing the OTP-confirmation screen (pre-filled code + Continue button).
        // Try clicking Continue first; then wait before re-checking.
        if (!isEnabled || currentVal.length >= 4) {
          const cont = await clickFirst(page, [
            'button[data-test-id="button-continue"]',
            'button:has-text("Continue")',
          ]);
          if (cont) {
            console.log(`[Login:${creds.email}] OTP confirmation — clicked Continue`);
          }
          await ms(1_000);
          continue;
        }

        console.log(`[Login:${creds.email}] OTP field — waiting for email code`);
        const otp = await waitForOtp(creds.email, creds.accountId);
        await fastFill(page, otpSel, otp);
        await ms(300);
        await dismissModal(page, 300);
        const sub = await clickFirst(page, SUBMIT_SELECTORS);
        console.log(`[Login:${creds.email}] OTP submitted via: ${sub}`);
        // Wait for Amazon to either navigate away or re-enable the input (wrong code)
        await ms(2_000);
        continue;
      }
    }

    // ── Post-login consent ────────────────────────────────────────────────────
    const consentSel = await waitForAny(page, [
      '[data-test-id="consentBtn"]',
      'button:has-text("Accept")',
      'button:has-text("Agree")',
    ], 500);
    if (consentSel) {
      await clickFirst(page, [consentSel]);
      console.log(`[Login:${creds.email}] Consent accepted`);
      await ms(300);
      continue;
    }

    await ms(400);
  }

  throw new Error("Login flow timed out after 120s — did not reach jobSearch");
}

// ─── CloudFront WAF block detection ──────────────────────────────────────────
async function isCloudFrontBlocked(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const text = document.body?.textContent ?? "";
    return text.includes("Generated by cloudfront") ||
           text.includes("Request blocked") ||
           (document.title.includes("403") && text.includes("CloudFront"));
  }).catch(() => false);
}

// ─── Shadow DOM captcha detection ────────────────────────────────────────────
// Simple text search — false-positives are handled by the sendCodeDone gate
// above; checking visibility is unreliable for elements inside shadow roots.
async function hasCaptchaHeading(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const TEXT = "Let's confirm you are human";
    if (document.body.textContent?.includes(TEXT)) return true;
    for (const host of Array.from(document.querySelectorAll("*"))) {
      if ((host as Element & { shadowRoot?: ShadowRoot }).shadowRoot?.textContent?.includes(TEXT)) return true;
    }
    return false;
  }).catch(() => false);
}

// ─── Modal dismissal ──────────────────────────────────────────────────────────
async function dismissModal(page: Page, waitMs = 2_000) {
  // Brief wait for modal to render (caller controls how long)
  if (waitMs > 0) {
    await page.waitForSelector('[data-test-component="StencilModalBackdrop"]', { timeout: waitMs }).catch(() => {});
  }

  const backdrop = page.locator('[data-test-component="StencilModalBackdrop"]');
  if (await backdrop.count() === 0) return;

  console.log("[Login] Modal detected — dismissing");

  const btnSelectors = [
    '[data-test-id="consentBtn"]',
    '[data-test-id="cookie-accept"]',
    '[data-test-id="cookieConsent-accept-button"]',
    '[data-test-id="accept-cookies-button"]',
    'button:has-text("Accept All")',
    'button:has-text("Accept Cookies")',
    'button:has-text("Accept")',
    'button:has-text("Agree")',
    'button:has-text("OK")',
    'button:has-text("Got it")',
    'button:has-text("Close")',
    '[data-test-component="StencilReactButton"]',
  ];

  let dismissed = false;
  for (const sel of btnSelectors) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.count() > 0 && await btn.isVisible({ timeout: 300 })) {
        await btn.click({ timeout: 3_000 });
        console.log(`[Login] Modal dismissed via: ${sel}`);
        dismissed = true;
        break;
      }
    } catch { /* try next */ }
  }

  if (!dismissed) {
    await page.keyboard.press("Escape").catch(() => {});
    await ms(200);
    if (await backdrop.count() > 0) {
      await backdrop.click({ force: true }).catch(() => {});
    }
  }

  await backdrop.waitFor({ state: "hidden", timeout: 3_000 }).catch(() => {});
}

// ─── Country selector ─────────────────────────────────────────────────────────
async function selectCountry(page: Page, country: "CA" | "US") {
  try {
    const toggle = await page.waitForSelector("#country-toggle-button", { timeout: 5_000 });
    const current = await toggle.textContent();
    const isCA = current?.includes("Canada");
    if ((country === "CA" && !isCA) || (country === "US" && isCA)) {
      await toggle.click();
      await ms(200);
      const option = country === "CA"
        ? page.locator('[data-test-id*="canada"], [data-value="CA"]')
        : page.locator('[data-test-id*="united"], [data-value="US"]');
      await option.click();
      await ms(200);
    }
  } catch { /* defaults to correct country */ }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Fast fill — click to focus then fill() in one shot (no per-character delay)
async function fastFill(page: Page, selector: string, text: string) {
  const el = page.locator(selector).first();
  try {
    await el.click({ timeout: 5_000 });
  } catch {
    await el.click({ force: true, timeout: 3_000 });
  }
  await el.fill(text);
}

// Returns the first selector that has a visible element within timeout
async function waitForAny(page: Page, selectors: string[], timeout: number): Promise<string | null> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const sel of selectors) {
      try {
        const el = page.locator(sel).first();
        if (await el.count() > 0 && await el.isVisible({ timeout: 150 })) return sel;
      } catch { /* not ready */ }
    }
    await page.waitForTimeout(200);
  }
  return null;
}

// Clicks the first visible button; falls back to force:true if backdrop intercepts
async function clickFirst(page: Page, selectors: string[]): Promise<string | null> {
  for (const sel of selectors) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.count() === 0) continue;
      if (!await btn.isVisible({ timeout: 300 }).catch(() => false)) continue;
      try {
        await btn.click({ timeout: 4_000 });
      } catch {
        await btn.click({ force: true, timeout: 2_000 });
      }
      return sel;
    } catch { /* try next */ }
  }
  return null;
}

// Scans localStorage + sessionStorage for a JWT access token.
// Amazon's SPA may write it under different key names or asynchronously
// after navigation, so we poll for up to 10s with a broad key scan.
async function extractAccessToken(page: Page): Promise<string> {
  const KNOWN_KEYS = [
    "accessToken", "access_token", "idToken", "id_token",
    "token", "authToken", "auth_token", "jwt",
    "amazon_access_token", "hiring_access_token",
  ];

  const scan = () => page.evaluate((knownKeys: string[]) => {
    const isJwt = (v: string | null) =>
      !!v && v.startsWith("eyJ") && v.split(".").length === 3;

    for (const store of [window.localStorage, window.sessionStorage]) {
      // Try known key names first
      for (const key of knownKeys) {
        const v = store.getItem(key);
        if (isJwt(v)) return v as string;
      }
      // Scan all keys for any JWT-shaped value
      for (let i = 0; i < store.length; i++) {
        const key = store.key(i);
        if (!key) continue;
        const v = store.getItem(key);
        if (isJwt(v)) return v as string;
      }
    }

    // Last resort: check cookies
    for (const part of document.cookie.split(";")) {
      const val = part.trim().split("=").slice(1).join("=");
      if (isJwt(val)) return val;
    }

    return "";
  }, KNOWN_KEYS);

  // Retry up to 10s — SPA may write the token after React render cycle
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const token = await scan().catch(() => "");
    if (token) return token;
    await ms(500);
  }
  return "";
}

function ms(n: number): Promise<void> {
  return new Promise((r) => setTimeout(r, n));
}
