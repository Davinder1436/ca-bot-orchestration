require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const OpenAI  = require('openai');
const { getUser, listUsers, createUser, updateUser, setCredits, addCredits, touchSeen, deleteUser } = require('./db');

const app  = express();
const PORT = process.env.PORT || 3001;

const selfUrl = () => process.env.BACKEND_URL || `http://localhost:${PORT}`;

app.use(cors());
app.use(express.json({ limit: '20mb' }));

// /solve-captcha is internal-only (worker → captcha-backend on Docker network)
// Admin routes below are protected by ADMIN_API_KEY

// ─── Request logger ────────────────────────────────────────────────────────────
app.use((req, res, next) => {
    const t0 = Date.now();
    const bodySize = req.headers['content-length']
        ? `${Math.round(parseInt(req.headers['content-length']) / 1024)}KB`
        : '?KB';
    console.log(`[req]  ${req.method} ${req.path} | body=${bodySize} | ip=${req.ip}`);
    res.on('finish', () => {
        console.log(`[res]  ${req.method} ${req.path} → ${res.statusCode} in ${Date.now() - t0}ms`);
    });
    next();
});

// ─── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
    let dbOk = true;
    try { getUser('__health_probe__'); } catch { dbOk = false; }
    res.json({
        status: 'ok',
        version: '1.0.0',
        db: dbOk,
        solvers: {
            gpt4o: !!process.env.OPENAI_API_KEY,
            groq:  !!process.env.GROQ_API_KEY,
        }
    });
});

// ─── POST /checkCredit ─────────────────────────────────────────────────────────
app.post('/checkCredit', (req, res) => {
    const { email, version, credits: clientCredits } = req.body;
    if (!email || typeof email !== 'string') {
        return res.status(400).json({ error: 'email is required' });
    }
    const host = selfUrl();
    const user = getUser(email.trim());
    if (!user) {
        console.log(`[credit] Unknown user: ${email}`);
        return res.json({ __cr: 0, __host: host, __sync: 5, __isProUser: false });
    }
    touchSeen(email.trim(), version);
    if (user.is_pro) {
        console.log(`[credit] Pro user: ${email}`);
        return res.json({ __cr: 999999, __host: host, __sync: user.sync_interval, __isProUser: true });
    }
    const newCredits = Math.max(0, user.credits - 1);
    setCredits(email.trim(), newCredits);
    console.log(`[credit] ${email} → ${user.credits} - 1 = ${newCredits}`);
    return res.json({ __cr: newCredits, __host: host, __sync: user.sync_interval, __isProUser: false });
});

// ─── POST /solve-captcha ───────────────────────────────────────────────────────
app.post('/solve-captcha', async (req, res) => {
    const { imageBase64, question, rows = 3, cols = 3 } = req.body;
    const imageSizeKB = imageBase64 ? Math.round(imageBase64.length / 1024) : 0;

    console.log(`[captcha] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`[captcha] REQUEST   | question="${question}" | grid=${rows}×${cols} | image=${imageSizeKB}KB`);

    if (!imageBase64) return res.status(400).json({ success: false, error: 'imageBase64 is required' });
    if (!question)   return res.status(400).json({ success: false, error: 'question is required' });

    const chain = [];
    if (process.env.OPENAI_API_KEY) chain.push({ name: 'gpt-4o', fn: () => solveWithGPT4o(imageBase64, question, rows, cols) });
    if (process.env.GROQ_API_KEY)   chain.push({ name: 'groq',   fn: () => solveWithGroq(imageBase64, question, rows, cols) });

    console.log(`[captcha] CHAIN     | [${chain.map(s => s.name).join(' → ')}]`);

    if (!chain.length) {
        console.error(`[captcha] ERROR     | No solver keys configured`);
        return res.status(500).json({ success: false, error: 'No API keys set — add OPENAI_API_KEY or XAI_API_KEY to .env' });
    }

    for (const solver of chain) {
        const t0 = Date.now();
        try {
            console.log(`[captcha] SOLVER    | Trying ${solver.name}...`);
            const { tiles, raw } = await solver.fn();
            const ms = Date.now() - t0;

            console.log(`[captcha] LLM RAW   | ${solver.name}: ${(raw ?? "").slice(0, 300)}`);
            console.log(`[captcha] PARSED    | ${solver.name}: ${JSON.stringify(tiles)} (${ms}ms)`);

            if (Array.isArray(tiles) && tiles.length > 0) {
                console.log(`[captcha] SUCCESS   | ${solver.name} → ${JSON.stringify(tiles)} in ${ms}ms`);
                return res.json({ success: true, tiles, solver: solver.name, modelRaw: raw });
            }
            console.warn(`[captcha] EMPTY     | ${solver.name} returned no tiles after ${ms}ms — trying next`);
        } catch (err) {
            console.error(`[captcha] FAILED    | ${solver.name} after ${Date.now() - t0}ms: ${err.message}`);
        }
    }

    console.error(`[captcha] ALL FAIL  | returning 500`);
    return res.status(500).json({ success: false, error: 'All solvers failed or returned no tiles' });
});

// ─── Solver: GPT-4o Vision ────────────────────────────────────────────────────
async function solveWithGPT4o(imageBase64, question, rows, cols) {
    // `fetch` must be passed explicitly — the SDK's bundled fetch fails in Docker
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, fetch });
    const prompt = buildPrompt(question, rows, cols);

    console.log(`[captcha:gpt-4o] Calling OpenAI gpt-4o...`);
    console.log(`[captcha:gpt-4o] Prompt: ${prompt.slice(0, 120).replace(/\n/g, ' ')}...`);

    const response = await openai.chat.completions.create({
        model: 'gpt-4o',
        max_tokens: 500,
        messages: [{
            role: 'user',
            content: [
                { type: 'text',      text: prompt },
                { type: 'image_url', image_url: { url: imageBase64, detail: 'high' } }
            ]
        }]
    });

    const raw = response.choices[0].message.content?.trim() ?? '';
    console.log(`[captcha:gpt-4o] Raw response: ${raw}`);

    const tiles = parseModelResponse(raw, rows, cols);
    console.log(`[captcha:gpt-4o] Parsed tiles: ${JSON.stringify(tiles)}`);
    return { tiles, raw };
}

// ─── Solver: Groq (Llama 4 Maverick Vision) ───────────────────────────────────
async function solveWithGroq(imageBase64, question, rows, cols) {
    // `fetch` must be passed explicitly — the SDK's bundled fetch fails in Docker
    const groq = new OpenAI({
        apiKey:  process.env.GROQ_API_KEY,
        baseURL: 'https://api.groq.com/openai/v1',
        fetch,
    });
    const prompt = buildPrompt(question, rows, cols);

    console.log(`[captcha:groq] Calling Groq meta-llama/llama-4-scout-17b-16e-instruct...`);
    console.log(`[captcha:groq] Prompt: ${prompt.slice(0, 120).replace(/\n/g, ' ')}...`);

    const response = await groq.chat.completions.create({
        model: 'meta-llama/llama-4-scout-17b-16e-instruct',
        max_tokens: 500,
        messages: [{
            role: 'user',
            content: [
                { type: 'text',      text: prompt },
                { type: 'image_url', image_url: { url: imageBase64 } }
            ]
        }]
    });

    const raw = response.choices[0].message.content?.trim() ?? '';
    console.log(`[captcha:groq] Raw response: ${raw}`);

    const tiles = parseModelResponse(raw, rows, cols);
    console.log(`[captcha:groq] Parsed tiles: ${JSON.stringify(tiles)}`);
    return { tiles, raw };
}

// ─── Shared prompt ─────────────────────────────────────────────────────────────
function buildPrompt(question, rows, cols) {
    return `You are solving an image CAPTCHA on Amazon's hiring portal ("Let's confirm you are human").

The screenshot shows a ${rows}×${cols} grid of image tiles (${rows * cols} tiles total).
Rows: 1 (top) → ${rows} (bottom)   Columns: 1 (left) → ${cols} (right)

Hint from the page: "${question}"

IMPORTANT: The image itself usually contains the REAL task text (e.g. "Choose all the fire hydrants", "Select all bicycles"). Look for that text IN the image — it overrides the hint above.

Steps:
1. Find and read the task instruction text visible in the image
2. Look at every tile in the ${rows}×${cols} grid
3. Identify which tiles clearly match the task object
4. Only include tiles you are confident about

Respond with ONLY a JSON array — no explanation, no markdown fences:
[{"row":1,"column":2},{"row":3,"column":1}]

If no tiles match: []`;
}

// ─── Parse model response ──────────────────────────────────────────────────────
function parseModelResponse(raw, rows, cols) {
    const text = raw
        .replace(/^```(?:json)?\s*/m, '')
        .replace(/\s*```$/m, '')
        .trim();

    const match = text.match(/\[[\s\S]*?\]/);
    if (!match) {
        console.warn(`[captcha] parse: no JSON array found in "${text.slice(0, 150)}"`);
        return [];
    }

    try {
        const parsed = JSON.parse(match[0]);
        if (!Array.isArray(parsed)) return [];

        const valid = parsed
            .filter(t => typeof t.row === 'number' && typeof t.column === 'number')
            .filter(t => t.row >= 1 && t.row <= rows && t.column >= 1 && t.column <= cols);

        if (valid.length !== parsed.length) {
            console.warn(`[captcha] parse: filtered ${parsed.length - valid.length} out-of-bounds tiles`);
        }
        return valid;
    } catch (e) {
        console.error(`[captcha] parse: JSON error — ${e.message} | input: ${match[0]}`);
        return [];
    }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Admin API ─────────────────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
    const key = process.env.ADMIN_API_KEY;
    if (!key) {
        return res.status(503).json({ error: 'Admin API is disabled. Set ADMIN_API_KEY in .env to enable.' });
    }
    const auth  = req.headers['authorization'] || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (token !== key) {
        return res.status(401).json({ error: 'Unauthorized — invalid or missing admin key' });
    }
    next();
}

app.get('/admin/users',                    requireAdmin, (_req, res) => res.json(listUsers()));
app.get('/admin/users/:email',             requireAdmin, (req, res) => {
    const user = getUser(decodeURIComponent(req.params.email));
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
});
app.post('/admin/users', requireAdmin, (req, res) => {
    const { email, credits = 0, is_pro = false, sync_interval = 1, notes } = req.body;
    if (!email) return res.status(400).json({ error: 'email is required' });
    if (getUser(email)) return res.status(409).json({ error: `User ${email} already exists` });
    try { res.status(201).json(createUser({ email, credits, is_pro, sync_interval, notes })); }
    catch (e) { res.status(400).json({ error: e.message }); }
});
app.patch('/admin/users/:email', requireAdmin, (req, res) => {
    const user = updateUser(decodeURIComponent(req.params.email), req.body);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
});
app.delete('/admin/users/:email', requireAdmin, (req, res) => {
    const deleted = deleteUser(decodeURIComponent(req.params.email));
    if (!deleted) return res.status(404).json({ error: 'User not found' });
    res.json({ ok: true });
});
app.post('/admin/users/:email/credits', requireAdmin, (req, res) => {
    const email  = decodeURIComponent(req.params.email);
    const { action = 'add', amount } = req.body;
    if (amount == null || isNaN(Number(amount))) return res.status(400).json({ error: 'amount (number) is required' });
    if (!getUser(email)) return res.status(404).json({ error: 'User not found' });
    if (action === 'set') setCredits(email, amount); else addCredits(email, amount);
    res.json(getUser(email));
});

// ─── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`[server] ──────────────────────────────────────────`);
    console.log(`[server] Captcha Backend  →  port ${PORT}`);
    console.log(`[server] Solvers          →  GPT-4o: ${!!process.env.OPENAI_API_KEY} | Groq (Llama 4): ${!!process.env.GROQ_API_KEY}`);
    console.log(`[server] Admin API        →  ${process.env.ADMIN_API_KEY ? 'enabled' : 'DISABLED'}`);
    console.log(`[server] Self URL         →  ${selfUrl()}`);
    console.log(`[server] ──────────────────────────────────────────`);
});
