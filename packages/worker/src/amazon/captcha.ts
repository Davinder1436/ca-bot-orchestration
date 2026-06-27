import type { Page } from "playwright";
import axios from "axios";
import sharp from "sharp";

const GROQ_API_KEY = process.env.GROQ_API_KEY ?? "";
const GROQ_MODEL   = "meta-llama/llama-4-scout-17b-16e-instruct";
const MAX_ATTEMPTS = 10;
const CONFIDENCE_THRESHOLD = 0.8;

const tag = (email: string) => `[Captcha:${email}]`;

const SKIP_PHRASES = ["incorrect", "please try again", "let's confirm", "confirm you are human", "choose all matching"];

function isUsableQuestion(q: string): boolean {
  if (!q || q.length < 8) return false;
  const lower = q.toLowerCase();
  return !SKIP_PHRASES.some(s => lower.includes(s));
}

export async function solveCaptchaOnPage(page: Page, accountEmail: string): Promise<void> {
  console.log(`${tag(accountEmail)} Starting solver — Groq Scout (${GROQ_MODEL})`);

  let persistedQuestion = "";

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (!await captchaVisible(page)) {
      console.log(`${tag(accountEmail)} Captcha not visible — already passed`);
      return;
    }

    console.log(`${tag(accountEmail)} ── Attempt ${attempt}/${MAX_ATTEMPTS} ──`);
    const attemptStart = Date.now();
    let screenshotMs = 0, aiMs = 0, clicksMs = 0;

    // Wait for the captcha dialog to be visible in the DOM, then immediately screenshot.
    await waitForCaptchaReady(page, accountEmail);

    const screenshotStart = Date.now();
    const imgs = await takeCaptchaImages(page);
    const rawB64   = `data:image/jpeg;base64,${imgs.raw.toString("base64")}`;
    const edgesB64 = `data:image/jpeg;base64,${imgs.edges.toString("base64")}`;
    const colorB64 = `data:image/jpeg;base64,${imgs.color.toString("base64")}`;
    screenshotMs = Date.now() - screenshotStart;
    console.log(`${tag(accountEmail)} Images: raw=${Math.round(imgs.raw.length/1024)}KB edges=${Math.round(imgs.edges.length/1024)}KB color=${Math.round(imgs.color.length/1024)}KB (${screenshotMs}ms)`);

    // Extract question from DOM / shadow DOM
    const rawQuestion = await extractQuestion(page);
    console.log(`${tag(accountEmail)} Raw question: "${rawQuestion}"`);
    if (isUsableQuestion(rawQuestion)) persistedQuestion = rawQuestion;
    const question = persistedQuestion || "Choose all matching tiles";
    console.log(`${tag(accountEmail)} Using question: "${question}"`);

    // Emit tile images to dashboard — rendered as visual tile grid, NOT raw base64 in text logs
    console.log(`[Captcha:tiles] ${JSON.stringify({ attempt, question, raw: rawB64, edges: edgesB64, color: colorB64 })}`);

    // Detect grid size
    const { rows, cols } = await detectGrid(page);
    console.log(`${tag(accountEmail)} Grid: ${rows}×${cols}`);

    // Groq vision API — Scout scores each tile with a confidence value
    let tiles: Array<{ row: number; column: number }> = [];
    const aiCallStart = Date.now();
    try {
      console.log(`${tag(accountEmail)} → Groq Scout (3-image confidence mode)`);
      const resp = await axios.post(
        "https://api.groq.com/openai/v1/chat/completions",
        {
          model: GROQ_MODEL,
          max_tokens: 512,
          messages: [
            {
              role: "system",
              content: buildSystemPrompt(rows, cols),
            },
            {
              role: "user",
              content: [
                { type: "text",      text: buildUserPrompt(question, rows, cols) },
                { type: "image_url", image_url: { url: rawB64 } },
                { type: "image_url", image_url: { url: edgesB64 } },
                { type: "image_url", image_url: { url: colorB64 } },
              ],
            },
          ],
        },
        {
          headers: { Authorization: `Bearer ${GROQ_API_KEY}`, "Content-Type": "application/json" },
          timeout: 15_000,
        }
      );
      aiMs = Date.now() - aiCallStart;
      const raw = (resp.data.choices?.[0]?.message?.content as string | undefined)?.trim() ?? "";
      console.log(`${tag(accountEmail)} ← Groq ${aiMs}ms raw: ${raw}`);
      tiles = parseTileConfidences(raw, rows, cols, accountEmail);
      console.log(`${tag(accountEmail)} Selected tiles: ${JSON.stringify(tiles)}`);
    } catch (err: unknown) {
      aiMs = Date.now() - aiCallStart;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`${tag(accountEmail)} Groq FAILED ${aiMs}ms: ${msg}`);
    }

    const clicksStart = Date.now();
    if (tiles.length === 0) {
      console.warn(`${tag(accountEmail)} No tiles returned — skipping clicks`);
    } else {
      console.log(`${tag(accountEmail)} Clicking ${tiles.length} tile(s)...`);
      for (const tile of tiles) {
        const ok = await clickGridTile(page, tile.row, tile.column, rows, cols);
        console.log(`${tag(accountEmail)}   tile (row=${tile.row} col=${tile.column}) → ${ok ? "clicked" : "missed"}`);
        // clickGridTile already does a double-rAF per tile; one final flush before submit
      }
      await page.evaluate(() => new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
    }
    clicksMs = Date.now() - clicksStart;

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

    // Wait for actual browser outcome — no static sleep
    const submitResult = await waitForSubmitResult(page, accountEmail);
    const postMs = Date.now() - clicksStart - clicksMs;
    const totalMs = Date.now() - attemptStart;
    console.log(
      `[Captcha:timing] attempt=${attempt} screenshot=${screenshotMs}ms AI=${aiMs}ms clicks=${clicksMs}ms post=${postMs}ms total=${totalMs}ms result=${submitResult}`
    );

    if (submitResult === "solved") {
      console.log(`${tag(accountEmail)} ✓ SOLVED on attempt ${attempt} (${totalMs}ms)`);
      return;
    }
    console.warn(`${tag(accountEmail)} Attempt ${attempt} ${submitResult} — retrying`);

    if (attempt < MAX_ATTEMPTS) {
      // Wait for "Incorrect" text to appear, click new challenge, then wait for it to clear
      await waitForNewChallenge(page, accountEmail);
    }
  }

  throw new Error(`[Captcha] FAILED after ${MAX_ATTEMPTS} attempts — stopping worker`);
}

// ─── Prompts ──────────────────────────────────────────────────────────────────

function buildSystemPrompt(rows: number, cols: number): string {
  return `You are an expert Amazon CAPTCHA solver. You will receive 3 images — all showing the SAME ${rows}×${cols} grid captcha from different visual perspectives.

HOW TO READ EACH IMAGE:
• Image 1 — Raw photo: The actual captcha as it appears in the browser. Use this as your primary reference for identifying object types. Row 1 = top row, row ${rows} = bottom row. Column 1 = left tile, column ${cols} = right tile.
• Image 2 — Sobel edge detection (grayscale): Object boundaries and contour shapes are amplified as bright lines. Use this to distinguish object silhouettes (e.g. a bucket's rounded body + handle arc vs. a flat bed frame) when objects are visually similar in Image 1.
• Image 3 — LAB color amplification (6×): Color differences are amplified 6× in perceptual color space. Objects that look nearly identical in color in Image 1 become vivid and clearly distinct here. Use this to catch low-contrast tiles — a bed that blends into a brick background in Image 1 will appear as a clearly different hue in Image 3.

STRATEGY:
1. Read the task in the user message to know the target object category.
2. Scan Image 1 to identify which tiles clearly show the target.
3. Cross-reference Image 2 (edges) to verify object shapes and boundaries.
4. Use Image 3 (color) to catch any ambiguous tiles where subtle color differences reveal the target hiding against a similar background.
5. Rate EVERY tile with a confidence float: 1.0 = definitely the target, 0.0 = definitely not.`;
}

function buildUserPrompt(question: string, rows: number, cols: number): string {
  return `Task: "${question}"

The 3 images above all show the same ${rows}×${cols} captcha grid (rows 1–${rows} top-to-bottom, columns 1–${cols} left-to-right).

For EVERY tile (${rows * cols} total), output your confidence (0.0–1.0) that the target object appears in that tile.

Reply with ONLY a JSON array of exactly ${rows * cols} objects — no markdown, no explanation:
[{"row":1,"column":1,"confidence":0.95},{"row":1,"column":2,"confidence":0.05},...]`;
}

// ─── Parse confidence response ────────────────────────────────────────────────
// Selects tiles where confidence >= CONFIDENCE_THRESHOLD and logs all scores.

function parseTileConfidences(
  raw: string,
  rows: number,
  cols: number,
  email: string,
): Array<{ row: number; column: number }> {
  const text  = raw.replace(/^```(?:json)?\s*/m, "").replace(/\s*```$/m, "").trim();
  const match = text.match(/\[[\s\S]*?\]/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]) as unknown[];
    if (!Array.isArray(parsed)) return [];

    type Entry = { row: number; column: number; confidence: number };
    const entries = (parsed as Array<{ row: unknown; column: unknown; confidence: unknown }>)
      .filter(t =>
        typeof t.row === "number" && typeof t.column === "number" && typeof t.confidence === "number" &&
        (t.row as number) >= 1 && (t.row as number) <= rows &&
        (t.column as number) >= 1 && (t.column as number) <= cols
      ) as Entry[];

    // Log every score so we can tune the threshold from logs
    const scoreLog = entries.map(e => `(${e.row},${e.column})=${e.confidence.toFixed(2)}`).join(" ");
    console.log(`${tag(email)} Confidence scores: ${scoreLog}`);

    return entries
      .filter(e => e.confidence >= CONFIDENCE_THRESHOLD)
      .map(({ row, column }) => ({ row, column }));
  } catch { return []; }
}

// ─── Wait for captcha dialog to appear ───────────────────────────────────────
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

// ─── Capture full grid + two processed variants ───────────────────────────────
// Same crop region as before (baseWidth × baseHeight = combined 3-strip dimensions).
// Returns raw JPEG, Sobel edge-detected grayscale JPEG, and LAB-color-amplified JPEG.
async function takeCaptchaImages(page: Page): Promise<{ raw: Buffer; edges: Buffer; color: Buffer }> {
  const vp = page.viewportSize() ?? { width: 1920, height: 1080 };
  const x      = Math.round(vp.width  * 0.36) + 40;
  const y      = Math.round(vp.height * 0.26) + 45;
  const width  = Math.round(vp.width  * 0.28) - 80;
  const height = Math.round(vp.height * 0.48) - 90;

  const raw = Buffer.from(await page.screenshot({ type: "jpeg", quality: 92, clip: { x, y, width, height } }));
  const [edges, color] = await Promise.all([applyGrayscaleSobel(raw), applyLabAmplified(raw)]);
  return { raw, edges, color };
}

// Sobel edge detection — highlights object boundaries as bright lines on black.
async function applyGrayscaleSobel(jpegBuf: Buffer): Promise<Buffer> {
  const { data, info } = await sharp(jpegBuf).raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;

  const gray = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    gray[i] = 0.299 * data[i * channels] + 0.587 * data[i * channels + 1] + 0.114 * data[i * channels + 2];
  }

  const out = Buffer.alloc(width * height * 3);
  for (let row = 1; row < height - 1; row++) {
    for (let col = 1; col < width - 1; col++) {
      const p = (dr: number, dc: number) => gray[(row + dr) * width + (col + dc)];
      const gx = -p(-1,-1) + p(-1,1) - 2*p(0,-1) + 2*p(0,1) - p(1,-1) + p(1,1);
      const gy = -p(-1,-1) - 2*p(-1,0) - p(-1,1) + p(1,-1) + 2*p(1,0) + p(1,1);
      const mag = Math.min(255, Math.sqrt(gx * gx + gy * gy));
      const idx = (row * width + col) * 3;
      out[idx] = out[idx + 1] = out[idx + 2] = mag;
    }
  }

  return sharp(out, { raw: { width, height, channels: 3 } }).jpeg({ quality: 92 }).toBuffer();
}

// LAB color amplification — A* and B* channels scaled 6× to make subtle color
// differences (e.g. bed vs. brick background) perceptually vivid.
async function applyLabAmplified(jpegBuf: Buffer): Promise<Buffer> {
  const { data, info } = await sharp(jpegBuf).raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const AMP = 6;
  const out = Buffer.alloc(width * height * 3);

  const lin  = (v: number) => v > 0.04045 ? ((v + 0.055) / 1.055) ** 2.4 : v / 12.92;
  const fLab = (t: number) => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
  const fInv = (t: number) => t > 0.2069   ? t ** 3         : (t - 16 / 116) / 7.787;
  const srgb = (v: number) => Math.max(0, Math.min(1,
    v > 0.0031308 ? 1.055 * v ** (1 / 2.4) - 0.055 : 12.92 * v
  ));

  for (let i = 0; i < width * height; i++) {
    const rl = lin(data[i * channels]     / 255);
    const gl = lin(data[i * channels + 1] / 255);
    const bl = lin(data[i * channels + 2] / 255);

    // Linear RGB → XYZ (D65)
    const X = (rl * 0.4124564 + gl * 0.3575761 + bl * 0.1804375) / 0.95047;
    const Y = (rl * 0.2126729 + gl * 0.7151522 + bl * 0.0721750);
    const Z = (rl * 0.0193339 + gl * 0.1191920 + bl * 0.9503041) / 1.08883;

    const fx = fLab(X), fy = fLab(Y), fz = fLab(Z);
    const L  = 116 * fy - 16;
    const A  = Math.max(-128, Math.min(127, 500 * (fx - fy) * AMP));
    const B  = Math.max(-128, Math.min(127, 200 * (fy - fz) * AMP));

    // LAB → XYZ → linear RGB
    const fy2 = (L + 16) / 116;
    const X2  = fInv(A / 500 + fy2) * 0.95047;
    const Y2  = fInv(fy2);
    const Z2  = fInv(fy2 - B / 200) * 1.08883;

    const idx = i * 3;
    out[idx]     = Math.round(srgb( 3.2404542 * X2 - 1.5371385 * Y2 - 0.4985314 * Z2) * 255);
    out[idx + 1] = Math.round(srgb(-0.9692660 * X2 + 1.8760108 * Y2 + 0.0415560 * Z2) * 255);
    out[idx + 2] = Math.round(srgb( 0.0556434 * X2 - 0.2040259 * Y2 + 1.0572252 * Z2) * 255);
  }

  return sharp(out, { raw: { width, height, channels: 3 } }).jpeg({ quality: 92 }).toBuffer();
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
          const withContent = ch.filter(c =>
            c.querySelector("img") ||
            window.getComputedStyle(c).backgroundImage !== "none"
          );
          if (withContent.length < Math.max(4, Math.ceil(ch.length * 0.4))) continue;
          return el as Element;
        }
        return null;
      }

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

      // Strategy A: uniform-grid container heuristic
      const grid = findGridContainer(modal);
      if (grid) {
        const ch  = visibleChildren(grid);
        const idx = (row - 1) * cols + (col - 1);
        if (idx < ch.length) {
          const r = ch[idx].getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2, strategy: "A" };
        }
      }

      // Strategy B: collect all <img> elements in modal
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

      // Strategy C: proven proportions
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
    // Flush the browser's JS event queue — guarantees click handler ran and DOM updated
    await page.evaluate(() => new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
    return true;
  }
  return false;
}

// ─── Wait for submit outcome ──────────────────────────────────────────────────
// Polls until captcha disappears (solved) or "Incorrect" text appears (wrong answer).
// No static sleep — resolves as soon as the browser signals a result.
async function waitForSubmitResult(
  page: Page,
  email: string,
  timeout = 8_000
): Promise<"solved" | "incorrect" | "timeout"> {
  console.log(`${tag(email)} Waiting for submit result...`);
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const state = await page.evaluate(() => {
      const HEADING   = "Let's confirm you are human";
      const INCORRECT = "Incorrect";
      function scan(root: Document | ShadowRoot): { heading: boolean; incorrect: boolean } {
        const txt = (root as Document).textContent ?? "";
        let heading = txt.includes(HEADING), incorrect = txt.includes(INCORRECT);
        for (const el of Array.from(root.querySelectorAll("*"))) {
          const s = (el as Element & { shadowRoot?: ShadowRoot }).shadowRoot;
          if (s) { const r = scan(s); heading ||= r.heading; incorrect ||= r.incorrect; }
        }
        return { heading, incorrect };
      }
      return scan(document);
    }).catch(() => ({ heading: true, incorrect: false }));

    if (!state.heading) return "solved";
    if (state.incorrect) return "incorrect";
    await new Promise(r => setTimeout(r, 80));
  }
  console.warn(`${tag(email)} waitForSubmitResult timed out`);
  return "timeout";
}

// ─── Wait for new challenge to be ready ───────────────────────────────────────
async function waitForNewChallenge(_page: Page, email: string): Promise<void> {
  console.log(`${tag(email)} Waiting 10s for new challenge to load...`);
  await new Promise(r => setTimeout(r, 10_000));
  console.log(`${tag(email)} New challenge ready`);
}

