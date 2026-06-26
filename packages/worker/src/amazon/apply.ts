import type { BrowserContext } from "playwright";
import { solveCaptchaOnPage } from "./captcha";

export async function applyForJob(
  context: BrowserContext,
  applyUrl: string,
  accountEmail: string
): Promise<boolean> {
  const page = await context.newPage();
  console.log(`[Apply:${accountEmail}] Navigating to consent URL`);

  try {
    await page.goto(applyUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await sleep(1500, 2500);

    // Handle CAPTCHA if present (throws after MAX_ATTEMPTS failures)
    const captchaPresent = await page.locator('text="Let\'s confirm you are human"').count();
    if (captchaPresent > 0) {
      await solveCaptchaOnPage(page, accountEmail);
    }

    // Click Next if present (Createapp flow)
    try {
      await page.locator('button:has-text("Next"), button[data-test-id="next-button"]').first().click({ timeout: 5_000 });
      await sleep(1000, 2000);
    } catch {}

    // Click Create Application
    try {
      await page.locator('button:has-text("Create Application"), button[data-test-id="create-application"]').first().click({ timeout: 8_000 });
      await sleep(2000, 3000);
      console.log(`[Apply:${accountEmail}] Application created`);
    } catch {
      // SPA may handle this without explicit button
      console.log(`[Apply:${accountEmail}] No create-application button found — SPA handled`);
    }

    // Confirm success by URL change or success message
    try {
      await page.waitForURL("**/confirmation**", { timeout: 15_000 });
      console.log(`[Apply:${accountEmail}] ✅ Application confirmed`);
      await page.close();
      return true;
    } catch {
      const successEl = await page.locator('text="Application submitted", text="You\'re registered"').count();
      if (successEl > 0) {
        console.log(`[Apply:${accountEmail}] ✅ Application confirmed (success text)`);
        await page.close();
        return true;
      }
    }

    await page.close();
    return false;
  } catch (err) {
    console.error(`[Apply:${accountEmail}] Error during application:`, err);
    await page.close().catch(() => {});
    return false;
  }
}

function sleep(min: number, max: number) {
  return new Promise((r) => setTimeout(r, min + Math.random() * (max - min)));
}
