import type { Page } from "playwright";
import axios from "axios";

const CAPTCHA_BACKEND = process.env.CAPTCHA_BACKEND_URL ?? "http://localhost:8000";
const INTERNAL_KEY = process.env.INTERNAL_API_KEY ?? "";
const MAX_ATTEMPTS = 6;

export async function solveCaptchaOnPage(page: Page, accountEmail: string): Promise<boolean> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // Detect CAPTCHA presence
    const captchaHeading = await page.locator('text="Let\'s confirm you are human"').count();
    if (captchaHeading === 0) return true; // No captcha present

    console.log(`[Captcha:${accountEmail}] Detected captcha (attempt ${attempt}/${MAX_ATTEMPTS})`);

    // Screenshot the captcha area
    const screenshotBuffer = await page.screenshot({ fullPage: false });
    const imageBase64 = `data:image/png;base64,${screenshotBuffer.toString("base64")}`;

    // Get question text
    const question = await page.locator('[class*="captcha"] h2, [class*="modal"] h2').first().textContent()
      ?? "Choose all matching tiles";

    // Detect grid size
    const { rows, cols } = await detectGrid(page);
    console.log(`[Captcha:${accountEmail}] Grid: ${rows}×${cols}, question: "${question}"`);

    let tiles: Array<{ row: number; column: number }> = [];
    try {
      const resp = await axios.post(
        `${CAPTCHA_BACKEND}/solve-captcha`,
        { imageBase64, question, rows, cols },
        { headers: { Authorization: `Bearer ${INTERNAL_KEY}` }, timeout: 30_000 }
      );
      if (resp.data.success) {
        tiles = resp.data.tiles;
        console.log(`[Captcha:${accountEmail}] Backend (${resp.data.solver}) returned ${tiles.length} tiles`);
      } else {
        console.warn(`[Captcha:${accountEmail}] Backend solve failed:`, resp.data.error);
      }
    } catch (err) {
      console.error(`[Captcha:${accountEmail}] Backend error:`, err);
    }

    // Click identified tiles with human-like delays
    for (const tile of tiles) {
      await clickGridTile(page, tile.row, tile.column, rows, cols);
      await sleep(220 + Math.random() * 280);
    }

    // Submit
    await page.locator('button[type="submit"], button:has-text("Submit"), button:has-text("Verify")').first().click();
    await sleep(2500);

    // Check if solved
    const stillPresent = await page.locator('text="Let\'s confirm you are human"').count();
    if (stillPresent === 0) {
      console.log(`[Captcha:${accountEmail}] Solved on attempt ${attempt}`);
      return true;
    }

    // Try reload button
    try {
      await page.locator('[aria-label*="reload"], [class*="reload"], button:has-text("Try again")').first().click();
      await sleep(1500);
    } catch {}
  }

  console.error(`[Captcha:${accountEmail}] Failed after ${MAX_ATTEMPTS} attempts`);
  return false;
}

async function detectGrid(page: Page): Promise<{ rows: number; cols: number }> {
  try {
    const result = await page.evaluate(() => {
      // Look for a uniform grid of images
      const candidates = document.querySelectorAll('[class*="grid"] img, [class*="captcha"] img, [role="grid"] img');
      const imgs = Array.from(candidates);
      if (imgs.length >= 4) {
        const sqrt = Math.sqrt(imgs.length);
        if (Number.isInteger(sqrt)) return { rows: sqrt, cols: sqrt };
        if (imgs.length === 9) return { rows: 3, cols: 3 };
        if (imgs.length === 16) return { rows: 4, cols: 4 };
      }
      return { rows: 3, cols: 3 };
    });
    return result;
  } catch {
    return { rows: 3, cols: 3 };
  }
}

async function clickGridTile(page: Page, row: number, col: number, rows: number, cols: number) {
  // Try DOM-based click first
  const clicked = await page.evaluate(
    ({ row, col, rows, cols }) => {
      const imgs = Array.from(document.querySelectorAll('[class*="grid"] img, [class*="captcha"] img, [role="grid"] img'));
      const index = (row - 1) * cols + (col - 1);
      const target = imgs[index] as HTMLElement | undefined;
      if (target) {
        target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
        target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        target.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
        return true;
      }
      return false;
    },
    { row, col, rows, cols }
  );

  if (!clicked) {
    // Fallback: click by estimated coordinate in viewport
    const vp = page.viewportSize();
    if (vp) {
      const cellW = vp.width / cols;
      const cellH = vp.height / rows;
      const x = (col - 0.5) * cellW;
      const y = (row - 0.5) * cellH;
      await page.mouse.click(x, y);
    }
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
