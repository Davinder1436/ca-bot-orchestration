import type { Page } from "playwright";
import axios from "axios";

const GROQ_API_KEY = process.env.GROQ_API_KEY ?? "";
const GROQ_MODEL   = "meta-llama/llama-4-scout-17b-16e-instruct";
const MAX_ATTEMPTS = 10;
const CONFIDENCE_THRESHOLD = 0.5;

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
    const rowBuffers = await takeRowScreenshots(page, accountEmail);
    const imageBase64s = rowBuffers.map(b => `data:image/jpeg;base64,${b.toString("base64")}`);
    screenshotMs = Date.now() - screenshotStart;
    console.log(`${tag(accountEmail)} Screenshots: ${rowBuffers.map(b => `${Math.round(b.length / 1024)}KB`).join("+")} (${screenshotMs}ms)`);

    // Extract question from DOM / shadow DOM
    const rawQuestion = await extractQuestion(page);
    console.log(`${tag(accountEmail)} Raw question: "${rawQuestion}"`);
    if (isUsableQuestion(rawQuestion)) persistedQuestion = rawQuestion;
    const question = persistedQuestion || "Choose all matching tiles";
    console.log(`${tag(accountEmail)} Using question: "${question}"`);

    // Emit tile images to dashboard — rendered as visual tile grid, NOT raw base64 in text logs
    console.log(`[Captcha:tiles] ${JSON.stringify({ attempt, question, r1: imageBase64s[0], r2: imageBase64s[1], r3: imageBase64s[2] })}`);

    // Detect grid size
    const { rows, cols } = await detectGrid(page);
    console.log(`${tag(accountEmail)} Grid: ${rows}×${cols}`);

    // Groq vision API — Scout scores each tile with a confidence value
    let tiles: Array<{ row: number; column: number }> = [];
    const aiCallStart = Date.now();
    try {
      console.log(`${tag(accountEmail)} → Groq Scout (confidence mode)`);
      const resp = await axios.post(
        "https://api.groq.com/openai/v1/chat/completions",
        {
          model: GROQ_MODEL,
          max_tokens: 512,
          messages: [{
            role: "user",
            content: [
              { type: "text",      text: buildCaptchaPrompt(question, rows, cols) },
              { type: "image_url", image_url: { url: imageBase64s[0] } },
              { type: "image_url", image_url: { url: imageBase64s[1] } },
              { type: "image_url", image_url: { url: imageBase64s[2] } },
            ],
          }],
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

// ─── Prompt ───────────────────────────────────────────────────────────────────

function buildCaptchaPrompt(question: string, rows: number, cols: number): string {
  const rowLabels = Array.from({ length: rows }, (_, i) =>
    `  Image ${i + 1} = Row ${i + 1} (${i === 0 ? "top" : i === rows - 1 ? "bottom" : "middle"})`
  ).join("\n");
  return `You are solving an Amazon image verification challenge.

The captcha shows a ${rows}×${cols} grid. I am sending ${rows} separate images — one per row:
${rowLabels}

Each image shows ${cols} tiles side by side: column 1 = left, column ${cols} = right.

Task: "${question}"

For EVERY tile in all ${rows} images, rate your confidence that the target object is present in that tile.
Use a float from 0.0 (definitely absent) to 1.0 (definitely present).

Reply with ONLY a JSON array of exactly ${rows * cols} objects — no explanation, no markdown:
[
  {"row":1,"column":1,"confidence":0.95},
  {"row":1,"column":2,"confidence":0.05},
  {"row":1,"column":3,"confidence":0.8},
  {"row":2,"column":1,"confidence":0.0},
  ...
]`;
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

// ─── Take 3 row-strip screenshots ────────────────────────────────────────────
// Crops 45px top+bottom to remove the question overlay, then splits the remaining
// dialog height into 3 equal strips — one per captcha grid row.
// Separate row images reduce per-image complexity for the vision model.
async function takeRowScreenshots(page: Page, _email: string): Promise<Buffer[]> {
  const vp = page.viewportSize() ?? { width: 1920, height: 1080 };
  const baseX      = Math.round(vp.width  * 0.36) + 40;   // +40px horizontal inset from each side
  const baseY      = Math.round(vp.height * 0.26) + 45;   // crop 45px from top
  const baseWidth  = Math.round(vp.width  * 0.28) - 80;   // -40px left + -40px right
  const baseHeight = Math.round(vp.height * 0.48) - 90;   // crop 45px top + 45px bottom
  const rowH       = Math.floor(baseHeight / 3);

  const buffers: Buffer[] = [];
  for (let i = 0; i < 3; i++) {
    const clip = { x: baseX, y: baseY + i * rowH, width: baseWidth, height: rowH };
    buffers.push(Buffer.from(await page.screenshot({ type: "jpeg", quality: 92, clip })));
  }
  return buffers;
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

