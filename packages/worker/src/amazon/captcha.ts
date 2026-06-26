import type { Page } from "playwright";
import axios from "axios";

const CAPTCHA_BACKEND = process.env.CAPTCHA_BACKEND_URL ?? "http://localhost:8000";
const MAX_ATTEMPTS = 3;

const tag = (email: string) => `[Captcha:${email}]`;

const SKIP_PHRASES = ["incorrect", "please try again", "let's confirm", "confirm you are human", "choose all matching"];

function isUsableQuestion(q: string): boolean {
  if (!q || q.length < 8) return false;
  const lower = q.toLowerCase();
  return !SKIP_PHRASES.some(s => lower.includes(s));
}

export async function solveCaptchaOnPage(page: Page, accountEmail: string): Promise<void> {
  console.log(`${tag(accountEmail)} Starting solver — backend: ${CAPTCHA_BACKEND}`);

  let persistedQuestion = "";

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (!await captchaVisible(page)) {
      console.log(`${tag(accountEmail)} Captcha not visible — already passed`);
      return;
    }

    console.log(`${tag(accountEmail)} ── Attempt ${attempt}/${MAX_ATTEMPTS} ──`);

    // Wait for the captcha dialog to be visible in the DOM, then immediately screenshot.
    // No static sleeps — we fire as soon as the heading text appears.
    await waitForCaptchaReady(page, accountEmail);

    const screenshotBuffer = await takeCroppedScreenshot(page, accountEmail);
    const imageBase64 = `data:image/jpeg;base64,${screenshotBuffer.toString("base64")}`;
    console.log(`${tag(accountEmail)} Screenshot: ${Math.round(screenshotBuffer.length / 1024)}KB`);
    // Dashboard captcha tab renders this as <img>
    console.log(`[Captcha:img] ${imageBase64}`);

    // Extract question from DOM / shadow DOM
    const rawQuestion = await extractQuestion(page);
    console.log(`${tag(accountEmail)} Raw question: "${rawQuestion}"`);
    if (isUsableQuestion(rawQuestion)) persistedQuestion = rawQuestion;
    const question = persistedQuestion || "Choose all matching tiles";
    console.log(`${tag(accountEmail)} Using question: "${question}"`);

    // Detect grid size
    const { rows, cols } = await detectGrid(page);
    console.log(`${tag(accountEmail)} Grid: ${rows}×${cols}`);

    // Send to captcha backend
    let tiles: Array<{ row: number; column: number }> = [];
    try {
      console.log(`${tag(accountEmail)} → POST ${CAPTCHA_BACKEND}/solve-captcha`);
      const resp = await axios.post(
        `${CAPTCHA_BACKEND}/solve-captcha`,
        { imageBase64, question, rows, cols },
        { timeout: 60_000 }
      );
      console.log(`${tag(accountEmail)} ← HTTP ${resp.status} solver=${resp.data.solver ?? "?"} success=${resp.data.success}`);
      if (resp.data.modelRaw) {
        console.log(`${tag(accountEmail)} [LLM response] ${resp.data.modelRaw}`);
      }
      if (resp.data.success) {
        tiles = resp.data.tiles ?? [];
        console.log(`${tag(accountEmail)} Tiles to click: ${JSON.stringify(tiles)}`);
      } else {
        console.warn(`${tag(accountEmail)} Backend success=false: ${resp.data.error ?? "unknown"}`);
      }
    } catch (err: unknown) {
      const msg    = err instanceof Error ? err.message : String(err);
      const status = axios.isAxiosError(err) ? err.response?.status : undefined;
      const body   = axios.isAxiosError(err) ? JSON.stringify(err.response?.data).slice(0, 200) : "";
      console.error(`${tag(accountEmail)} Backend FAILED: ${msg}${status ? ` (HTTP ${status})` : ""}${body ? ` — ${body}` : ""}`);
    }

    if (tiles.length === 0) {
      console.warn(`${tag(accountEmail)} No tiles returned — skipping clicks`);
    } else {
      console.log(`${tag(accountEmail)} Clicking ${tiles.length} tile(s)...`);
      for (const tile of tiles) {
        const ok = await clickGridTile(page, tile.row, tile.column, rows, cols);
        console.log(`${tag(accountEmail)}   tile (row=${tile.row} col=${tile.column}) → ${ok ? "clicked" : "missed"}`);
        await sleep(250 + Math.random() * 300);
      }
    }

    // Click Confirm — button lives inside shadow DOM so page.locator() can't find it.
    console.log(`${tag(accountEmail)} Clicking submit...`);
    const submitted = await page.evaluate(() => {
      const CONFIRM_TEXTS = ["confirm", "submit", "verify", "continue"];
      function findButton(root: Document | ShadowRoot): HTMLButtonElement | null {
        for (const el of Array.from(root.querySelectorAll("*"))) {
          const s = (el as Element & { shadowRoot?: ShadowRoot }).shadowRoot;
          if (s) {
            const found = findButton(s);
            if (found) return found;
          }
        }
        for (const btn of Array.from(root.querySelectorAll("button"))) {
          const text = btn.textContent?.trim().toLowerCase() ?? "";
          if (CONFIRM_TEXTS.some(t => text.includes(t))) return btn as HTMLButtonElement;
        }
        return null;
      }
      const btn = findButton(document);
      if (btn) { btn.click(); return true; }
      return false;
    });
    console.log(`${tag(accountEmail)} Submit: ${submitted ? "clicked" : "button not found"}`);
    await sleep(2_500);

    const stillVisible = await captchaVisible(page);
    if (!stillVisible) {
      console.log(`${tag(accountEmail)} ✓ SOLVED on attempt ${attempt}`);
      return;
    }
    console.warn(`${tag(accountEmail)} Still visible after attempt ${attempt} — retrying`);

    if (attempt < MAX_ATTEMPTS) {
      await page.evaluate(() => {
        const RETRY_TEXTS = ["try again", "new challenge", "reload", "refresh"];
        function findRetry(root: Document | ShadowRoot): HTMLButtonElement | null {
          for (const el of Array.from(root.querySelectorAll("*"))) {
            const s = (el as Element & { shadowRoot?: ShadowRoot }).shadowRoot;
            if (s) { const f = findRetry(s); if (f) return f; }
          }
          for (const btn of Array.from(root.querySelectorAll("button, [role='button']"))) {
            const text = btn.textContent?.trim().toLowerCase() ?? "";
            if (RETRY_TEXTS.some(t => text.includes(t))) return btn as HTMLButtonElement;
          }
          return null;
        }
        const btn = findRetry(document);
        if (btn) btn.click();
      }).catch(() => {});
      await sleep(1_500);
    }
  }

  throw new Error(`[Captcha] FAILED after ${MAX_ATTEMPTS} attempts — stopping worker`);
}

// ─── Wait for captcha dialog to appear ───────────────────────────────────────
// Fires the instant "Let's confirm you are human" appears anywhere in the DOM
// (including shadow roots). No static sleep.
async function waitForCaptchaReady(page: Page, email: string): Promise<void> {
  console.log(`${tag(email)} Waiting for captcha heading in DOM...`);
  await page.waitForFunction(
    () => {
      const TEXT = "Let's confirm you are human";
      function hasText(root: Document | ShadowRoot): boolean {
        if (((root as Document).textContent ?? "").includes(TEXT)) return true;
        for (const el of Array.from(root.querySelectorAll("*"))) {
          const s = (el as Element & { shadowRoot?: ShadowRoot }).shadowRoot;
          if (s && hasText(s)) return true;
        }
        return false;
      }
      return hasText(document);
    },
    { timeout: 30_000 }
  ).catch(() => {
    console.log(`${tag(email)} waitForCaptchaReady timeout — proceeding anyway`);
  });
  console.log(`${tag(email)} Captcha heading detected`);
}

// ─── Take cropped screenshot via Chrome extension captureVisibleTab ───────────
// Content scripts run in an isolated JS world so window.__captureTab is not
// directly accessible from page.evaluate (main world). We use a postMessage
// bridge: page sends { __action: 'captureTab', __id } and content.js replies
// with { __captureTabResult: id, imageData } — GPU-composited, all 9 tiles.
// Fallback: page.screenshot() crop (grey rows 2-3 likely; last resort).
async function takeCroppedScreenshot(page: Page, email: string): Promise<Buffer> {
  try {
    const dataUrl: string | null = await page.evaluate(() =>
      new Promise<string | null>((resolve) => {
        const reqId = Math.random().toString(36).slice(2);

        const timer = setTimeout(() => {
          window.removeEventListener("message", onMsg);
          resolve(null);
        }, 12_000);

        function onMsg(ev: MessageEvent) {
          if (ev.data?.__captureTabResult !== reqId) return;
          clearTimeout(timer);
          window.removeEventListener("message", onMsg);
          resolve((ev.data.imageData as string | null) ?? null);
        }

        window.addEventListener("message", onMsg);
        window.postMessage({ __action: "captureTab", __id: reqId }, "*");
      })
    );

    if (dataUrl && dataUrl.startsWith("data:image/")) {
      const b64 = dataUrl.replace(/^data:image\/[^;]+;base64,/, "");
      const buf = Buffer.from(b64, "base64");
      console.log(`${tag(email)} captureVisibleTab: ${Math.round(buf.length / 1024)}KB ✓`);
      return buf;
    }
    console.warn(`${tag(email)} captureVisibleTab returned null — extension not ready`);
  } catch (err) {
    console.warn(`${tag(email)} captureVisibleTab failed: ${err}`);
  }

  // Fallback: page.screenshot with centre crop
  console.log(`${tag(email)} Falling back to page.screenshot()`);
  const vp = page.viewportSize() ?? { width: 1920, height: 1080 };
  const clip = {
    x:      Math.round(vp.width  * 0.30),
    y:      Math.round(vp.height * 0.20),
    width:  Math.round(vp.width  * 0.40),
    height: Math.round(vp.height * 0.60),
  };
  const buf = Buffer.from(await page.screenshot({ type: "jpeg", quality: 90, clip }));
  console.log(`${tag(email)} page.screenshot: ${Math.round(buf.length / 1024)}KB`);
  return buf;
}

// ─── Shadow DOM captcha visibility ───────────────────────────────────────────
async function captchaVisible(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const TEXT = "Let's confirm you are human";
    if (document.body.textContent?.includes(TEXT)) return true;
    for (const host of Array.from(document.querySelectorAll("*"))) {
      if ((host as Element & { shadowRoot?: ShadowRoot }).shadowRoot?.textContent?.includes(TEXT)) return true;
    }
    return false;
  }).catch(() => false);
}

// ─── Question extraction ──────────────────────────────────────────────────────
async function extractQuestion(page: Page): Promise<string> {
  return (page.evaluate(() => {
    const Q_RE = /^(choose|select|click|pick)\s+all\b/i;

    function searchRoot(root: Document | ShadowRoot): string | null {
      for (const el of Array.from(root.querySelectorAll("*"))) {
        const shadow = (el as Element & { shadowRoot?: ShadowRoot }).shadowRoot;
        if (shadow) {
          const found = searchRoot(shadow);
          if (found) return found;
        }
        const raw  = (el.textContent ?? "").trim();
        const text = raw.replace(/(\s*\d+)+$/, "").trim();
        if (text.length >= 8 && text.length <= 100 && Q_RE.test(text)) {
          return text;
        }
      }
      return null;
    }

    return searchRoot(document);
  }) as Promise<string | null>).then(r => r ?? "").catch(() => "");
}

// ─── Grid detection ───────────────────────────────────────────────────────────
async function detectGrid(page: Page): Promise<{ rows: number; cols: number }> {
  try {
    return await page.evaluate(() => {
      function fromRoot(root: Document | ShadowRoot): { rows: number; cols: number } | null {
        const imgs = Array.from(root.querySelectorAll(
          '[class*="grid"] img, [class*="captcha"] img, [role="grid"] img, [class*="tile"] img, [class*="challenge"] img'
        ));
        if (imgs.length === 9)  return { rows: 3, cols: 3 };
        if (imgs.length === 16) return { rows: 4, cols: 4 };
        if (imgs.length >= 4) {
          const sqrt = Math.round(Math.sqrt(imgs.length));
          if (sqrt * sqrt === imgs.length) return { rows: sqrt, cols: sqrt };
        }
        for (const el of Array.from(root.querySelectorAll("*"))) {
          const shadow = (el as Element & { shadowRoot?: ShadowRoot }).shadowRoot;
          if (shadow) {
            const result = fromRoot(shadow);
            if (result) return result;
          }
        }
        return null;
      }
      return fromRoot(document) ?? { rows: 3, cols: 3 };
    });
  } catch {
    return { rows: 3, cols: 3 };
  }
}

// ─── Click a grid tile ────────────────────────────────────────────────────────
async function clickGridTile(page: Page, row: number, col: number, rows: number, cols: number): Promise<boolean> {
  // Compute tile centre coordinates using two strategies, in priority order.
  // Strategy A: find the grid CONTAINER (uniform-sized children heuristic, mirrors
  //   the old extension's findGridTiles), get visible children by index, return their
  //   bounding rect centre. Avoids the class-name guessing that was matching wrong images.
  // Strategy B: collect every <img> inside the modal across all shadow DOM levels.
  //   If ≥ (rows×cols) found, derive the grid rect from their bounding rects.
  // Strategy C: fall back to the proportions proven by the old extension:
  //   left=5%, top=22%, width=90%, height=63% of the modal rect.
  const coords = await page.evaluate(
    ({ row, col, rows, cols }) => {
      const TEXT = "Let's confirm you are human";

      function isVisible(el: Element): boolean {
        const r = el.getBoundingClientRect();
        if (r.width < 5 || r.height < 5) return false;
        const s = window.getComputedStyle(el);
        return s.display !== "none" && s.visibility !== "hidden";
      }
      function visibleChildren(el: Element): Element[] {
        return Array.from(el.children).filter(isVisible);
      }

      // Smallest element containing captcha heading with size ≥ 150×200
      function findModal(): Element | null {
        let best: Element | null = null;
        let bestArea = Infinity;
        function search(root: Document | ShadowRoot) {
          for (const el of Array.from(root.querySelectorAll("*"))) {
            const s = (el as Element & { shadowRoot?: ShadowRoot }).shadowRoot;
            if (s) search(s);
            if (!(el.textContent ?? "").includes(TEXT)) continue;
            const r = el.getBoundingClientRect();
            if (r.width < 150 || r.height < 200) continue;
            const area = r.width * r.height;
            if (area < bestArea) { bestArea = area; best = el as Element; }
          }
        }
        search(document);
        return best;
      }

      // Strategy A: uniform-grid heuristic — find a container div/ul/ol whose
      // direct visible children are roughly the same size and contain image content.
      function findGridContainer(root: Document | ShadowRoot | Element): Element | null {
        for (const el of Array.from(root.querySelectorAll("div,ul,ol"))) {
          const s = (el as Element & { shadowRoot?: ShadowRoot }).shadowRoot;
          if (s) {
            const inner = findGridContainer(s);
            if (inner) return inner;
          }
          if (!isVisible(el as Element)) continue;
          const ch = visibleChildren(el as Element);
          if (ch.length < 4 || ch.length > 25) continue;
          const rects = ch.map(c => c.getBoundingClientRect());
          const ws = rects.map(r => r.width);
          const hs = rects.map(r => r.height);
          const avgW = ws.reduce((a, b) => a + b, 0) / ws.length;
          const avgH = hs.reduce((a, b) => a + b, 0) / hs.length;
          if (avgW < 20 || avgH < 20) continue;
          if ((Math.max(...ws) - Math.min(...ws)) > avgW * 0.35 &&
              (Math.max(...hs) - Math.min(...hs)) > avgH * 0.35) continue;
          // At least 40% of children must have an img or background image
          const withContent = ch.filter(c =>
            c.querySelector("img") ||
            window.getComputedStyle(c).backgroundImage !== "none"
          );
          if (withContent.length < Math.max(4, Math.ceil(ch.length * 0.4))) continue;
          return el as Element;
        }
        return null;
      }

      // Strategy B: collect all <img> elements recursively through all shadow roots
      function collectImgs(root: Document | ShadowRoot | Element): HTMLImageElement[] {
        const imgs: HTMLImageElement[] = [];
        for (const el of Array.from(root.querySelectorAll("*"))) {
          if ((el as Element).tagName === "IMG" && isVisible(el as Element)) {
            imgs.push(el as HTMLImageElement);
          }
          const s = (el as Element & { shadowRoot?: ShadowRoot }).shadowRoot;
          if (s) imgs.push(...collectImgs(s));
        }
        return imgs;
      }

      const modal = findModal();
      if (!modal) return null;
      const mRect = modal.getBoundingClientRect();

      // Strategy A ─────────────────────────────────────────────────────────────
      const grid = findGridContainer(modal);
      if (grid) {
        const ch  = visibleChildren(grid);
        const idx = (row - 1) * cols + (col - 1);
        if (idx < ch.length) {
          const r = ch[idx].getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2, strategy: "A" };
        }
      }

      // Strategy B ─────────────────────────────────────────────────────────────
      const allImgs = collectImgs(modal).filter(img => {
        const r = img.getBoundingClientRect();
        return r.left >= mRect.left - 10 && r.right  <= mRect.right  + 10 &&
               r.top  >= mRect.top  - 10 && r.bottom <= mRect.bottom + 10;
      });
      if (allImgs.length >= rows * cols) {
        const rects   = allImgs.slice(0, rows * cols).map(i => i.getBoundingClientRect());
        const gLeft   = Math.min(...rects.map(r => r.left));
        const gTop    = Math.min(...rects.map(r => r.top));
        const gRight  = Math.max(...rects.map(r => r.right));
        const gBottom = Math.max(...rects.map(r => r.bottom));
        const tW = (gRight  - gLeft) / cols;
        const tH = (gBottom - gTop)  / rows;
        return { x: gLeft + (col - 0.5) * tW, y: gTop + (row - 0.5) * tH, strategy: "B" };
      }

      // Strategy C — proportions from old extension (proven on live Amazon captchas)
      const gLeft   = mRect.left  + mRect.width  * 0.05;
      const gTop    = mRect.top   + mRect.height * 0.22;
      const gWidth  = mRect.width  * 0.90;
      const gHeight = mRect.height * 0.63;
      const tW = gWidth  / cols;
      const tH = gHeight / rows;
      return { x: gLeft + (col - 0.5) * tW, y: gTop + (row - 0.5) * tH, strategy: "C" };
    },
    { row, col, rows, cols }
  );

  if (coords) {
    console.log(`[Captcha] tile(${row},${col}) strategy=${coords.strategy} → (${Math.round(coords.x)},${Math.round(coords.y)})`);
    await page.mouse.click(coords.x, coords.y);
    return true;
  }
  return false;
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
