require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const OpenAI   = require('openai');
const axios    = require('axios');
const { getUser, listUsers, createUser, updateUser, setCredits, addCredits, touchSeen, deleteUser } = require('./db');

const app  = express();
const PORT = process.env.PORT || 3001;

// Self-referential URL returned to clients so they always know where to point.
// Set BACKEND_URL in .env for production (e.g. https://your-app.azurewebsites.net)
const selfUrl = () => process.env.BACKEND_URL || `http://localhost:${PORT}`;

app.use(cors());
app.use(express.json({ limit: '20mb' }));

// Internal auth: /solve-captcha requires INTERNAL_API_KEY bearer token
// when INTERNAL_API_KEY is set in the environment (production safety)
app.use('/solve-captcha', (req, res, next) => {
    const internalKey = process.env.INTERNAL_API_KEY;
    if (!internalKey) return next(); // no key configured — allow all (dev mode)
    const auth = req.headers['authorization'] ?? '';
    if (auth !== `Bearer ${internalKey}`) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
});

// ============================================================
// Request logger — logs every incoming request with timing
// ============================================================
app.use((req, res, next) => {
    const t0  = Date.now();
    const bodySize = req.headers['content-length']
        ? `${Math.round(parseInt(req.headers['content-length']) / 1024)}KB`
        : '?KB';
    console.log(`[req]  ${req.method} ${req.path} | body=${bodySize} | ip=${req.ip}`);
    res.on('finish', () => {
        console.log(`[res]  ${req.method} ${req.path} → ${res.statusCode} in ${Date.now()-t0}ms`);
    });
    next();
});

// ============================================================
// Health check
// ============================================================
app.get('/health', (_req, res) => {
    let dbOk = true;
    try { getUser('__health_probe__'); } catch (e) { dbOk = false; }
    res.json({
        status:  'ok',
        version: '1.0.0',
        db:      dbOk,
        solvers: {
            gpt4o:      !!process.env.OPENAI_API_KEY,
            capmonster: !!process.env.CAPMONSTER_API_KEY,
            twocaptcha: !!process.env.TWOCAPTCHA_API_KEY
        }
    });
});

// ============================================================
// POST /checkCredit
//
// Called periodically by the extension (fetch.js B() function).
// This is the exact endpoint the original Azure creditchecker backend served.
//
// Request body (from extension):
//   { email, version, credits }   ← 'credits' = client's local count (informational)
//
// Response (stored back into chrome.storage.local by the extension):
//   { __cr, __host, __sync, __isProUser }
//   __cr         — server-authoritative credit balance
//   __host       — backend URL (allows hot-swap redirect)
//   __sync       — sync interval multiplier; extension delay = __sync × 60 × 1000 ms
//   __isProUser  — boolean; when true, extension skips future credit calls
// ============================================================
app.post('/checkCredit', (req, res) => {
    const { email, version, credits: clientCredits } = req.body;

    if (!email || typeof email !== 'string') {
        return res.status(400).json({ error: 'email is required' });
    }

    const host = selfUrl();
    const user = getUser(email.trim());

    // Unknown user — not registered, return 0 credits.
    // Sync every 5 min so they can be added and immediately start working.
    if (!user) {
        console.log(`[credit] Unknown user: ${email}`);
        return res.json({ __cr: 0, __host: host, __sync: 5, __isProUser: false });
    }

    // Record last-seen timestamp + version string
    touchSeen(email.trim(), version);

    // Pro users: unlimited, no deduction
    if (user.is_pro) {
        console.log(`[credit] Pro user: ${email} — no deduction`);
        return res.json({ __cr: 999999, __host: host, __sync: user.sync_interval, __isProUser: true });
    }

    // Regular users: deduct 1 credit per sync cycle
    const newCredits = Math.max(0, user.credits - 1);
    setCredits(email.trim(), newCredits);
    console.log(`[credit] ${email} → ${user.credits} - 1 = ${newCredits} credits remaining`);

    return res.json({ __cr: newCredits, __host: host, __sync: user.sync_interval, __isProUser: false });
});

// ============================================================
// POST /solve-captcha
//
// Body:
//   imageBase64  — data URI or raw base64 of the CAPTCHA modal screenshot
//   question     — instruction text, e.g. "Choose all the curtains"
//   rows         — grid row count (default 3)
//   cols         — grid column count (default 3)
//
// Response:
//   { success: true,  tiles: [{row, column}, ...], solver: "gpt4o"|"capmonster"|"2captcha" }
//   { success: false, error: "..." }
// ============================================================
app.post('/solve-captcha', async (req, res) => {
    const { imageBase64, question, rows = 3, cols = 3 } = req.body;
    const imageSizeKB = imageBase64 ? Math.round(imageBase64.length / 1024) : 0;
    console.log(`[captcha] ENTRY | question="${question}" | grid=${rows}x${cols} | imageSize=${imageSizeKB}KB`);

    if (!imageBase64) return res.status(400).json({ success: false, error: 'imageBase64 is required' });
    if (!question)   return res.status(400).json({ success: false, error: 'question is required' });

    // Build solver chain in priority order based on which keys are configured
    const chain = [];
    if (process.env.OPENAI_API_KEY)     chain.push({ name: 'gpt4o',      fn: () => solveWithGPT4o(imageBase64, question, rows, cols) });
    if (process.env.CAPMONSTER_API_KEY) chain.push({ name: 'capmonster', fn: () => solveWithGridAPI('https://api.capmonster.cloud', process.env.CAPMONSTER_API_KEY, imageBase64, question, rows, cols) });
    if (process.env.TWOCAPTCHA_API_KEY) chain.push({ name: '2captcha',   fn: () => solveWithGridAPI('https://api.2captcha.com',       process.env.TWOCAPTCHA_API_KEY,  imageBase64, question, rows, cols) });

    console.log(`[captcha] Solver chain: [${chain.map(s=>s.name).join(', ')}] | keys present: openai=${!!process.env.OPENAI_API_KEY}, capmonster=${!!process.env.CAPMONSTER_API_KEY}, 2captcha=${!!process.env.TWOCAPTCHA_API_KEY}`);

    if (!chain.length) {
        return res.status(500).json({ success: false, error: 'No solver API keys set. Add OPENAI_API_KEY, CAPMONSTER_API_KEY, or TWOCAPTCHA_API_KEY to .env' });
    }

    for (const solver of chain) {
        const t0 = Date.now();
        try {
            console.log(`[captcha] Trying solver: ${solver.name}`);
            const tiles = await solver.fn();
            const elapsed = Date.now() - t0;
            if (Array.isArray(tiles) && tiles.length > 0) {
                console.log(`[captcha] ${solver.name} SOLVED in ${elapsed}ms → ${JSON.stringify(tiles)}`);
                return res.json({ success: true, tiles, solver: solver.name });
            }
            console.warn(`[captcha] ${solver.name} returned empty tiles after ${elapsed}ms — trying next solver`);
        } catch (err) {
            const elapsed = Date.now() - t0;
            console.error(`[captcha] ${solver.name} FAILED after ${elapsed}ms: ${err.message}`);
        }
    }

    console.error('[captcha] All solvers failed — returning 500');
    return res.status(500).json({ success: false, error: 'All solvers failed or returned no tiles' });
});

// ============================================================
// Solver 1: OpenAI GPT-4o Vision (primary — highest accuracy)
// ============================================================
async function solveWithGPT4o(imageBase64, question, rows, cols) {
    const openai   = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const imageUrl = imageBase64.startsWith('data:')
        ? imageBase64
        : `data:image/png;base64,${imageBase64}`;

    const prompt =
        `You are solving a visual CAPTCHA grid puzzle.\n` +
        `Grid: ${rows} rows × ${cols} columns (${rows * cols} tiles total).\n` +
        `Task hint: "${question}"\n` +
        `IMPORTANT: If the image itself contains the task question (e.g. "Choose all the buckets"), use THAT question — it overrides the hint above.\n\n` +
        `Rules:\n` +
        `- Examine every tile carefully.\n` +
        `- Select ONLY tiles that clearly match the task.\n` +
        `- Rows and columns are 1-indexed. Top-left = row 1 col 1. Bottom-right = row ${rows} col ${cols}.\n\n` +
        `Respond with ONLY a raw JSON array — no explanation, no markdown fences.\n` +
        `Example: [{"row":1,"column":1},{"row":2,"column":3}]\n` +
        `If no tiles match, respond with: []`;

    const response = await openai.chat.completions.create({
        model:      'gpt-4o',
        max_tokens: 300,
        messages: [{
            role: 'user',
            content: [
                { type: 'text',      text:       prompt   },
                { type: 'image_url', image_url: { url: imageUrl, detail: 'high' } }
            ]
        }]
    });

    const raw     = response.choices[0].message.content.trim();
    const cleaned = raw.replace(/^```(?:json)?\s*/m, '').replace(/\s*```$/m, '').trim();
    const parsed  = JSON.parse(cleaned);

    if (!Array.isArray(parsed)) throw new Error('GPT-4o did not return a JSON array');

    // Validate and clamp coordinates
    return parsed
        .filter(t => typeof t.row === 'number' && typeof t.column === 'number')
        .filter(t => t.row >= 1 && t.row <= rows && t.column >= 1 && t.column <= cols);
}

// ============================================================
// Solver 2 & 3: CapMonster / 2captcha — GridTask
// Both services share the same REST API format.
//
// GridTask response: solution.click = [1, 3, 5, ...]
//   (1-based linear cell index, reading left→right, top→bottom)
//   Cell n → row = ceil(n/cols), column = n - (row-1)*cols
// ============================================================
async function solveWithGridAPI(baseUrl, apiKey, imageBase64, question, rows, cols) {
    const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');

    // Step 1: Create task
    const createResp = await axios.post(
        `${baseUrl}/createTask`,
        {
            clientKey: apiKey,
            task: {
                type:    'GridTask',
                body:    base64Data,
                rows,
                columns: cols,
                comment: question
            }
        },
        { timeout: 15000 }
    );

    if (createResp.data.errorId !== 0) {
        throw new Error(`createTask error ${createResp.data.errorId}: ${createResp.data.errorCode}`);
    }

    const taskId = createResp.data.taskId;
    console.log(`[captcha] ${baseUrl} taskId=${taskId} — polling...`);

    // Step 2: Poll for result (max 20 × 3s = 60s)
    for (let attempt = 0; attempt < 20; attempt++) {
        await sleep(3000);

        const resultResp = await axios.post(
            `${baseUrl}/getTaskResult`,
            { clientKey: apiKey, taskId },
            { timeout: 10000 }
        );

        if (resultResp.data.errorId !== 0) {
            throw new Error(`getTaskResult error: ${resultResp.data.errorCode}`);
        }

        if (resultResp.data.status === 'ready') {
            const clicks = resultResp.data.solution?.click || [];
            // Convert 1-based linear index → {row, column}
            return clicks.map(n => ({
                row:    Math.ceil(n / cols),
                column: n - (Math.ceil(n / cols) - 1) * cols
            }));
        }
        // status === 'processing' — keep polling
    }

    throw new Error(`Grid task timed out after 60s (taskId=${taskId})`);
}

// ============================================================
// Utility
// ============================================================
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ============================================================
// Admin API  —  protected by ADMIN_API_KEY (Bearer token)
//
// All routes require:  Authorization: Bearer <ADMIN_API_KEY>
//
// Routes:
//   GET    /admin/users                       — list all users
//   POST   /admin/users                       — create user
//   GET    /admin/users/:email                — get single user
//   PATCH  /admin/users/:email                — update user fields
//   DELETE /admin/users/:email                — delete user
//   POST   /admin/users/:email/credits        — add or set credits
// ============================================================
function requireAdmin(req, res, next) {
    const key = process.env.ADMIN_API_KEY;
    if (!key) {
        // No key configured — admin routes disabled for safety
        return res.status(503).json({ error: 'Admin API is disabled. Set ADMIN_API_KEY in .env to enable.' });
    }
    const auth = req.headers['authorization'] || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (token !== key) {
        return res.status(401).json({ error: 'Unauthorized — invalid or missing admin key' });
    }
    next();
}

// GET /admin/users
app.get('/admin/users', requireAdmin, (_req, res) => {
    res.json(listUsers());
});

// POST /admin/users  — { email, credits, is_pro, sync_interval, notes }
app.post('/admin/users', requireAdmin, (req, res) => {
    const { email, credits = 0, is_pro = false, sync_interval = 1, notes } = req.body;
    if (!email) return res.status(400).json({ error: 'email is required' });
    if (getUser(email)) return res.status(409).json({ error: `User ${email} already exists` });
    try {
        const user = createUser({ email, credits, is_pro, sync_interval, notes });
        res.status(201).json(user);
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// GET /admin/users/:email
app.get('/admin/users/:email', requireAdmin, (req, res) => {
    const user = getUser(decodeURIComponent(req.params.email));
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
});

// PATCH /admin/users/:email  — { credits?, is_pro?, sync_interval?, notes? }
app.patch('/admin/users/:email', requireAdmin, (req, res) => {
    const email = decodeURIComponent(req.params.email);
    const user = updateUser(email, req.body);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
});

// DELETE /admin/users/:email
app.delete('/admin/users/:email', requireAdmin, (req, res) => {
    const deleted = deleteUser(decodeURIComponent(req.params.email));
    if (!deleted) return res.status(404).json({ error: 'User not found' });
    res.json({ ok: true });
});

// POST /admin/users/:email/credits  — { action: 'add'|'set', amount: number }
app.post('/admin/users/:email/credits', requireAdmin, (req, res) => {
    const email  = decodeURIComponent(req.params.email);
    const { action = 'add', amount } = req.body;
    if (amount == null || isNaN(Number(amount))) {
        return res.status(400).json({ error: 'amount (number) is required' });
    }
    if (!getUser(email)) return res.status(404).json({ error: 'User not found' });
    if (action === 'set') {
        setCredits(email, amount);
    } else {
        addCredits(email, amount);
    }
    res.json(getUser(email));
});

// ============================================================
// Start server
// ============================================================
app.listen(PORT, () => {
    console.log(`[server] ─────────────────────────────────────────`);
    console.log(`[server] Shifter Backend  →  port ${PORT}`);
    console.log(`[server] CAPTCHA solvers  →  GPT-4o: ${!!process.env.OPENAI_API_KEY} | CapMonster: ${!!process.env.CAPMONSTER_API_KEY} | 2captcha: ${!!process.env.TWOCAPTCHA_API_KEY}`);
    console.log(`[server] Credit DB        →  ${process.env.DB_PATH || 'data/shifter.db'}`);
    console.log(`[server] Admin API        →  ${process.env.ADMIN_API_KEY ? 'enabled' : 'DISABLED (set ADMIN_API_KEY)'}`);
    console.log(`[server] Self URL         →  ${selfUrl()}`);
    console.log(`[server] ─────────────────────────────────────────`);
});
