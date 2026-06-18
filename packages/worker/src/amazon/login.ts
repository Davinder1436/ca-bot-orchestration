import type { BrowserContext, Page } from "playwright";
import { waitForOtp } from "./otp-waiter";

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
  await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });

  // Select country
  await selectCountry(page, creds.country);

  // Fill email
  await page.waitForSelector('input[data-test-id="input-test-id-login"]', { timeout: 15_000 });
  await humanType(page, 'input[data-test-id="input-test-id-login"]', creds.email);
  await delay(500, 900);

  // Click Continue
  const continueBtn = page.locator('button[data-test-id="button-continue"]');
  await continueBtn.click();
  await delay(1000, 2000);

  // Fill PIN
  const pinField = page.locator('input[data-test-id="input-test-id-pin"]');
  await pinField.waitFor({ timeout: 15_000 });
  await humanType(page, 'input[data-test-id="input-test-id-pin"]', creds.pin);
  await delay(300, 700);

  // Click Submit
  const submitBtn = page.locator('button[data-test-id="button-sign-in"]');
  await submitBtn.click();
  console.log(`[Login:${creds.email}] Submitted credentials`);

  // Detect OTP requirement (Amazon sometimes sends OTP on first login or new device)
  try {
    const otpField = await page.waitForSelector(
      'input[data-test-id="input-test-id-otp"], input[type="tel"][maxlength="6"]',
      { timeout: 8_000 }
    );
    if (otpField) {
      console.log(`[Login:${creds.email}] OTP required — waiting for email`);
      const otp = await waitForOtp(creds.email, creds.accountId);
      await humanType(page, 'input[data-test-id="input-test-id-otp"], input[type="tel"][maxlength="6"]', otp);
      await delay(300, 600);
      await page.locator('button[data-test-id="button-sign-in"], button[type="submit"]').click();
      console.log(`[Login:${creds.email}] OTP submitted`);
    }
  } catch {
    // No OTP field — normal login flow
  }

  // Handle consent if present
  try {
    const consentBtn = await page.waitForSelector(
      'button[data-test-component="StencilReactButton"][data-test-id="consentBtn"]',
      { timeout: 5_000 }
    );
    await consentBtn.click();
    console.log(`[Login:${creds.email}] Consent accepted`);
    await delay(1000, 2000);
  } catch {
    // No consent page
  }

  // Wait for job search page to confirm login succeeded
  await page.waitForURL(`**/app#/jobSearch**`, { timeout: 30_000 });
  console.log(`[Login:${creds.email}] Login successful`);

  // Extract access token from localStorage
  const token = await page.evaluate(() => window.localStorage.getItem("accessToken") ?? "");
  if (!token) throw new Error("Could not extract access token after login");

  await page.close();
  return token;
}

async function selectCountry(page: Page, country: "CA" | "US") {
  try {
    const toggle = await page.waitForSelector("#country-toggle-button", { timeout: 5_000 });
    const current = await toggle.textContent();
    const isCA = current?.includes("Canada");
    if ((country === "CA" && !isCA) || (country === "US" && isCA)) {
      await toggle.click();
      await delay(300, 600);
      const option = country === "CA"
        ? page.locator('[data-test-id*="canada"], [data-value="CA"]')
        : page.locator('[data-test-id*="united"], [data-value="US"]');
      await option.click();
      await delay(300, 600);
    }
  } catch {
    // Country toggle may not be shown if it defaults correctly
  }
}

async function humanType(page: Page, selector: string, text: string) {
  const el = page.locator(selector).first();
  await el.click();
  await el.fill("");
  // Type with slight character delays for realism
  for (const char of text) {
    await el.pressSequentially(char, { delay: 40 + Math.random() * 80 });
  }
}

function delay(min: number, max: number): Promise<void> {
  return new Promise((r) => setTimeout(r, min + Math.random() * (max - min)));
}
