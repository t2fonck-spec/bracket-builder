# Bracket Builder Public Launch — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Bracket Builder as a public, monetized product on Railway with per-bracket + lifetime pricing, 64-team support, NCAA template, and a landing page — before March 19 NCAA tournament tip-off.

**Architecture:** Express + SQLite SPA. Backend changes to server.js (payment flow, R2 upload, rate limiting, password reset, 64-team, NCAA template). Frontend changes to index.html/app.js/style.css (payment modal, landing page, round labels, NCAA button). Deploy to Railway with R2 for images.

**Tech Stack:** Node.js 20, Express, better-sqlite3, Stripe, @aws-sdk/client-s3, express-rate-limit, nodemailer (Resend SMTP), html2canvas

**Spec:** `docs/superpowers/specs/2026-03-11-public-launch-design.md`

---

## Chunk 1: Infrastructure & Backend Foundation

### Task 1: Install dependencies and create nixpacks.toml

**Files:**
- Modify: `package.json`
- Create: `nixpacks.toml`

- [ ] **Step 1: Install new npm packages**

```bash
cd ~/claude-workspace/bracket-builder
npm install @aws-sdk/client-s3 express-rate-limit
```

- [ ] **Step 2: Create nixpacks.toml**

```toml
# nixpacks.toml
[phases.setup]
nixPkgs = ["nodejs_20", "python3"]

[start]
cmd = "node server.js"
```

This pins Node 20 + python3 (python3 needed for node-gyp to build better-sqlite3 native addon on Railway).

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json nixpacks.toml
git commit -m "feat: add R2/rate-limit deps and nixpacks.toml for Railway"
```

---

### Task 2: Replace multer disk upload with Cloudflare R2

**Files:**
- Modify: `server.js:7-9` (imports), `server.js:95-112` (upload setup), `server.js:180-191` (upload route)

The current upload flow uses multer to write to `public/uploads/` on disk. Replace with: multer writes to a memory buffer → upload buffer to R2 → return R2 public URL.

- [ ] **Step 1: Add R2 client setup to server.js**

At the top of server.js, after existing imports, add:

```js
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const r2 = process.env.R2_ACCOUNT_ID ? new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
}) : null;
```

- [ ] **Step 2: Change multer storage from disk to memory**

Replace the existing multer `storage: multer.diskStorage(...)` block with:

```js
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(Object.assign(new Error('Only image files allowed'), { code: 'INVALID_TYPE' }));
    }
  },
});
```

Remove the `UPLOADS_DIR` constant and `fs.mkdirSync(UPLOADS_DIR...)` lines.

- [ ] **Step 3: Rewrite the upload route to push to R2**

Replace the `POST /api/upload` handler with:

```js
app.post('/api/upload', auth, (req, res) => {
  upload.single('image')(req, res, async (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'Image must be under 5MB' });
      if (err.code === 'INVALID_TYPE') return res.status(400).json({ error: 'Only image files allowed' });
      return res.status(400).json({ error: err.message });
    }
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const ext = path.extname(req.file.originalname).toLowerCase() || '.jpg';
    const key = crypto.randomBytes(16).toString('hex') + ext;

    if (r2) {
      try {
        await r2.send(new PutObjectCommand({
          Bucket: process.env.R2_BUCKET_NAME,
          Key: key,
          Body: req.file.buffer,
          ContentType: req.file.mimetype,
        }));
        res.json({ url: `${process.env.R2_PUBLIC_URL}/${key}` });
      } catch (e) {
        console.error('R2 upload error:', e);
        res.status(500).json({ error: 'Image upload failed' });
      }
    } else {
      // Fallback to disk for local dev (no R2 configured)
      const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');
      fs.mkdirSync(UPLOADS_DIR, { recursive: true });
      fs.writeFileSync(path.join(UPLOADS_DIR, key), req.file.buffer);
      res.json({ url: '/uploads/' + key });
    }
  });
});
```

- [ ] **Step 4: Verify upload still works locally**

```bash
# Start the server
node server.js &
# Upload a test image (no R2 env vars = falls back to disk)
curl -s -X POST http://localhost:3000/api/upload \
  -H "Authorization: Bearer $(curl -s -X POST http://localhost:3000/api/login -H 'Content-Type: application/json' -d '{"email":"test@test.com","password":"testpassword123"}' | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).token))')" \
  -F "image=@/usr/share/icons/hicolor/48x48/apps/firefox.png" 2>/dev/null
# Should return { "url": "/uploads/xxx.png" }
kill %1
```

- [ ] **Step 5: Commit**

```bash
git add server.js
git commit -m "feat: replace multer disk storage with R2 upload (disk fallback for dev)"
```

---

### Task 3: Add rate limiting

**Files:**
- Modify: `server.js` (after middleware section, ~line 93)

- [ ] **Step 1: Add rate limiter middleware**

After `app.use(express.static(...))`, add:

```js
const rateLimit = require('express-rate-limit');

const voteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' },
});
```

- [ ] **Step 2: Apply limiters to routes**

Add `authLimiter` as middleware on auth routes:

```js
app.post('/api/register', authLimiter, async (req, res) => { ... });
app.post('/api/login', authLimiter, async (req, res) => { ... });
```

Add `voteLimiter` on the vote route:

```js
app.post('/api/brackets/:slug/vote', voteLimiter, (req, res) => { ... });
```

- [ ] **Step 3: Verify rate limiting works**

```bash
node server.js &
# Hit login 6 times rapidly
for i in $(seq 1 6); do curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3000/api/login -H 'Content-Type: application/json' -d '{"email":"x","password":"x"}'; done
# First 5 should be 401, 6th should be 429
kill %1
```

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat: add rate limiting on vote and auth endpoints"
```

---

### Task 4: Add password reset (backend)

**Files:**
- Modify: `server.js` (migrations array ~line 85, new routes after auth routes ~line 169)

- [ ] **Step 1: Add DB migration**

Add to the migrations array (line 85-88):

```js
'ALTER TABLE users ADD COLUMN reset_token TEXT',
'ALTER TABLE users ADD COLUMN reset_token_expires INTEGER',
```

- [ ] **Step 2: Configure nodemailer transport**

After the JWT_SECRET/STRIPE_SECRET declarations (~line 22), add:

```js
const transporter = process.env.RESEND_SMTP_PASS ? require('nodemailer').createTransport({
  host: 'smtp.resend.com',
  port: 465,
  secure: true,
  auth: { user: process.env.RESEND_SMTP_USER || 'resend', pass: process.env.RESEND_SMTP_PASS },
}) : null;
```

- [ ] **Step 3: Add forgot-password route**

After the `GET /api/me` route, add:

```js
app.post('/api/forgot-password', authLimiter, async (req, res) => {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Email required' });
  // Always return ok to avoid leaking whether email exists
  res.json({ ok: true });
  // Send reset email in background
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase().trim());
  if (!user || !transporter) return;
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('UPDATE users SET reset_token = ?, reset_token_expires = ? WHERE id = ?')
    .run(token, Date.now() + 3600000, user.id);
  try {
    await transporter.sendMail({
      from: `Bracket Builder <noreply@${new URL(BASE_URL).hostname}>`,
      to: user.email,
      subject: 'Reset your password',
      html: `<p>Click the link below to reset your password. This link expires in 1 hour.</p>
             <p><a href="${BASE_URL}/reset-password?token=${token}">Reset Password</a></p>
             <p>If you didn't request this, ignore this email.</p>`,
    });
  } catch (e) {
    console.error('Email send error:', e);
  }
});
```

- [ ] **Step 4: Add reset-password route**

```js
app.post('/api/reset-password', async (req, res) => {
  const { token, password } = req.body || {};
  if (!token || !password) return res.status(400).json({ error: 'Token and password required' });
  if (password.length < 12) return res.status(400).json({ error: 'Password must be at least 12 characters' });
  const user = db.prepare('SELECT * FROM users WHERE reset_token = ? AND reset_token_expires > ?')
    .get(token, Date.now());
  if (!user) return res.status(400).json({ error: 'Invalid or expired reset link' });
  const hash = await bcrypt.hash(password, 10);
  db.prepare('UPDATE users SET password_hash = ?, reset_token = NULL, reset_token_expires = NULL WHERE id = ?')
    .run(hash, user.id);
  res.json({ ok: true });
});
```

- [ ] **Step 5: Verify migration runs**

```bash
node -e "
const Database = require('better-sqlite3');
const db = new Database('./data/brackets.db');
['ALTER TABLE users ADD COLUMN reset_token TEXT',
 'ALTER TABLE users ADD COLUMN reset_token_expires INTEGER'].forEach(s => { try { db.exec(s); } catch {} });
const cols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
console.log(cols.includes('reset_token') && cols.includes('reset_token_expires') ? 'OK' : 'FAIL');
"
```

Expected: `OK`

- [ ] **Step 6: Commit**

```bash
git add server.js
git commit -m "feat: add password reset endpoints with Resend SMTP"
```

---

### Task 5: Add 64-team seedings and dashboard filter

**Files:**
- Modify: `server.js:194-204` (GET /api/brackets query), `server.js:209` (valid sizes), `server.js:295-300` (SEEDINGS object)

- [ ] **Step 1: Add 64-team seedings**

Add to the `SEEDINGS` object (after the 32-team entry):

```js
64: [[1,16],[8,9],[5,12],[4,13],[6,11],[3,14],[7,10],[2,15],
     [17,32],[24,25],[21,28],[20,29],[22,27],[19,30],[23,26],[18,31],
     [33,48],[40,41],[37,44],[36,45],[38,43],[35,46],[39,42],[34,47],
     [49,64],[56,57],[53,60],[52,61],[54,59],[51,62],[55,58],[50,63]]
```

- [ ] **Step 2: Update valid bracket sizes**

In `POST /api/brackets` (line 209), change:

```js
const bracketSize = [8, 16, 32].includes(Number(size)) ? Number(size) : 8;
```

To:

```js
const bracketSize = [8, 16, 32, 64].includes(Number(size)) ? Number(size) : 8;
```

- [ ] **Step 3: Filter pending_payment brackets from dashboard**

In `GET /api/brackets`, change the WHERE clause from:

```sql
WHERE b.user_id = ?
```

To:

```sql
WHERE b.user_id = ? AND b.status != 'pending_payment'
```

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat: add 64-team seedings, update valid sizes, filter pending_payment from dashboard"
```

---

### Task 6: NCAA template endpoints

**Files:**
- Create: `data/ncaa-2026.json`
- Modify: `server.js` (new routes after bracket routes)

- [ ] **Step 1: Create placeholder NCAA template file**

Create `data/ncaa-2026.json`:

```json
[]
```

An empty array means "not available yet." Populated manually after Selection Sunday (March 15).

- [ ] **Step 2: Add GET /api/ncaa-template**

```js
app.get('/api/ncaa-template', (req, res) => {
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'data', 'ncaa-2026.json'), 'utf8');
    const teams = JSON.parse(raw);
    if (!Array.isArray(teams) || teams.length !== 64) {
      return res.json({ available: false });
    }
    res.json({ available: true, teams });
  } catch {
    res.json({ available: false });
  }
});
```

- [ ] **Step 3: Add POST /api/brackets/ncaa**

This creates a 64-team bracket with all teams pre-seeded from the template. It must go BEFORE the `/:slug` catch-all route in server.js.

```js
const REGION_OFFSET = { East: 0, West: 16, South: 32, Midwest: 48 };

app.post('/api/brackets/ncaa', auth, async (req, res) => {
  // Load template
  let teams;
  try {
    teams = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'ncaa-2026.json'), 'utf8'));
    if (!Array.isArray(teams) || teams.length !== 64) throw new Error('not ready');
  } catch {
    return res.status(400).json({ error: 'NCAA 2026 template is not available yet' });
  }

  const bracketSize = 64;

  // Payment gate for non-pro users
  if (req.user.tier !== 'pro') {
    const slug = 'ncaa-2026-' + crypto.randomBytes(3).toString('hex');
    const row = db.prepare('INSERT INTO brackets (user_id, title, slug, size, status) VALUES (?, ?, ?, ?, ?)')
      .run(req.user.id, 'NCAA Tournament 2026', slug, bracketSize, 'pending_payment');
    const bracketId = row.lastInsertRowid;

    // Seed all 64 participants now (so they're ready after payment)
    const insertP = db.prepare('INSERT INTO participants (bracket_id, name, img, seed) VALUES (?, ?, NULL, ?)');
    db.transaction(() => {
      for (const t of teams) {
        const globalSeed = REGION_OFFSET[t.region] + t.seed;
        insertP.run(bracketId, t.name, globalSeed);
      }
    })();

    // Create Stripe checkout
    if (!STRIPE_SECRET) return res.status(503).json({ error: 'Payments not configured' });
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{ price: process.env.STRIPE_PRICE_64, quantity: 1 }],
      mode: 'payment',
      success_url: `${BASE_URL}/#manage/${slug}?payment=success`,
      cancel_url: `${BASE_URL}/?payment=cancelled`,
      metadata: { bracket_id: String(bracketId), user_id: String(req.user.id), purchase_type: 'per_bracket' },
    });
    return res.json({ slug, checkoutUrl: session.url, requiresPayment: true });
  }

  // Pro user: create directly
  const slug = 'ncaa-2026-' + crypto.randomBytes(3).toString('hex');
  const row = db.prepare('INSERT INTO brackets (user_id, title, slug, size, is_paid, status) VALUES (?, ?, ?, ?, 1, ?)')
    .run(req.user.id, 'NCAA Tournament 2026', slug, bracketSize, 'setup');
  const bracketId = row.lastInsertRowid;

  const insertP = db.prepare('INSERT INTO participants (bracket_id, name, img, seed) VALUES (?, ?, NULL, ?)');
  db.transaction(() => {
    for (const t of teams) {
      const globalSeed = REGION_OFFSET[t.region] + t.seed;
      insertP.run(bracketId, t.name, globalSeed);
    }
  })();

  res.status(201).json({ slug, requiresPayment: false });
});
```

- [ ] **Step 4: Commit**

```bash
git add server.js data/ncaa-2026.json
git commit -m "feat: add NCAA 2026 template endpoints"
```

---

### Task 7: Rewrite payment flow (backend)

**Files:**
- Modify: `server.js:114-123` (auth middleware), `server.js:206-225` (POST /api/brackets), `server.js:566-614` (Stripe checkout + webhook)

This is the most delicate task. The existing `/api/checkout` and webhook handler need to be replaced with the new per-bracket + lifetime flow.

- [ ] **Step 0: Fix auth middleware to refresh tier from DB**

The JWT caches `tier` from login time. After a lifetime purchase via webhook, `req.user.tier` would remain `'free'` until re-login. Fix by refreshing tier from DB:

```js
function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const payload = jwt.verify(header.slice(7), JWT_SECRET);
    const user = db.prepare('SELECT id, email, tier FROM users WHERE id = ?').get(payload.id);
    if (!user) return res.status(401).json({ error: 'User not found' });
    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}
```

Also update `optionalAuth` similarly:

```js
function optionalAuth(req, res, next) {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    try {
      const payload = jwt.verify(header.slice(7), JWT_SECRET);
      req.user = db.prepare('SELECT id, email, tier FROM users WHERE id = ?').get(payload.id);
    } catch {}
  }
  next();
}
```

- [ ] **Step 0b: Initialize Stripe client once at top of file**

After the `JWT_SECRET` / `STRIPE_SECRET` declarations, add:

```js
const stripe = STRIPE_SECRET ? require('stripe')(STRIPE_SECRET) : null;
```

Then use `stripe` directly in all route handlers instead of `require('stripe')(STRIPE_SECRET)` per-request.

- [ ] **Step 1: Rewrite POST /api/brackets to include payment gate**

Replace the existing `POST /api/brackets` handler:

```js
app.post('/api/brackets', auth, async (req, res) => {
  const { title, size } = req.body || {};
  if (!title?.trim()) return res.status(400).json({ error: 'Title required' });
  const bracketSize = [8, 16, 32, 64].includes(Number(size)) ? Number(size) : 8;

  const slug = title.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
    + '-' + crypto.randomBytes(3).toString('hex');

  // Free tier: 8-team brackets always allowed
  if (bracketSize <= 8 || req.user.tier === 'pro') {
    try {
      const row = db.prepare('INSERT INTO brackets (user_id, title, slug, size, is_paid, status) VALUES (?, ?, ?, ?, ?, ?)')
        .run(req.user.id, title.trim(), slug, bracketSize, req.user.tier === 'pro' ? 1 : 0, 'setup');
      return res.status(201).json({ id: row.lastInsertRowid, title: title.trim(), slug, size: bracketSize, status: 'setup' });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Failed to create bracket' });
    }
  }

  // Non-pro user wants 16/32/64 — create pending_payment and return Stripe checkout
  if (!STRIPE_SECRET) return res.status(503).json({ error: 'Payments not configured' });

  try {
    const row = db.prepare('INSERT INTO brackets (user_id, title, slug, size, status) VALUES (?, ?, ?, ?, ?)')
      .run(req.user.id, title.trim(), slug, bracketSize, 'pending_payment');
    const bracketId = row.lastInsertRowid;

    const priceMap = { 16: process.env.STRIPE_PRICE_16, 32: process.env.STRIPE_PRICE_32, 64: process.env.STRIPE_PRICE_64 };
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{ price: priceMap[bracketSize], quantity: 1 }],
      mode: 'payment',
      success_url: `${BASE_URL}/#manage/${slug}?payment=success`,
      cancel_url: `${BASE_URL}/?payment=cancelled`,
      metadata: { bracket_id: String(bracketId), user_id: String(req.user.id), purchase_type: 'per_bracket' },
    });

    res.status(201).json({ id: bracketId, title: title.trim(), slug, size: bracketSize, status: 'pending_payment', checkoutUrl: session.url });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to create bracket' });
  }
});
```

- [ ] **Step 2: Add lifetime checkout endpoint**

Replace the existing `/api/checkout` route with:

```js
app.post('/api/checkout/lifetime', auth, async (req, res) => {
  if (!STRIPE_SECRET) return res.status(503).json({ error: 'Payments not configured' });
  if (req.user.tier === 'pro') return res.status(400).json({ error: 'Already a Pro user' });

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{ price: process.env.STRIPE_PRICE_LIFETIME, quantity: 1 }],
      mode: 'payment',
      success_url: `${BASE_URL}/?upgraded=1`,
      cancel_url: `${BASE_URL}/?cancelled=1`,
      metadata: { user_id: String(req.user.id), purchase_type: 'lifetime' },
    });
    res.json({ url: session.url });
  } catch (e) {
    console.error('Stripe error:', e.message);
    res.status(500).json({ error: 'Checkout failed' });
  }
});
```

- [ ] **Step 3: Rewrite webhook handler**

Replace the existing webhook handler:

```js
app.post('/api/webhook', (req, res) => {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) return res.status(400).send('Not configured');
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    return res.status(400).send(`Webhook error: ${e.message}`);
  }
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const purchaseType = session.metadata?.purchase_type;
    if (purchaseType === 'lifetime') {
      const userId = parseInt(session.metadata?.user_id, 10);
      if (userId) db.prepare('UPDATE users SET tier = ? WHERE id = ?').run('pro', userId);
    } else if (purchaseType === 'per_bracket') {
      const bracketId = parseInt(session.metadata?.bracket_id, 10);
      if (bracketId) {
        db.prepare('UPDATE brackets SET is_paid = 1, status = ? WHERE id = ? AND status = ?')
          .run('setup', bracketId, 'pending_payment');
      }
    }
  }
  res.json({ received: true });
});
```

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat: rewrite payment flow — per-bracket + lifetime Stripe checkout"
```

---

## Chunk 2: Frontend Changes

### Task 8: Add 64-team round labels in frontend

**Files:**
- Modify: `public/app.js` — `renderRoundLabels()` function and bracket size options

- [ ] **Step 1: Update round label names for 64-team brackets**

In `public/app.js`, find the `renderRoundLabels()` function (around line 715). The existing `nameMap` only maps the last 3 rounds. Replace the `nameMap` block inside `renderRoundLabels()` with:

```js
  let nameMap;
  if (bracket.size === 64) {
    nameMap = {
      1: 'Round of 64', 2: 'Round of 32', 3: 'Sweet 16',
      4: 'Elite Eight', 5: 'Final Four', 6: 'Championship'
    };
  } else {
    nameMap = {
      [totalRounds]:     'Final',
      [totalRounds - 1]: 'Semis',
      [totalRounds - 2]: 'Quarters',
    };
  }
```

- [ ] **Step 2: Add 64 to bracket size options in the UI**

In `public/index.html`, find the size options `<div class="size-options">` (line 196). After the 32-team `<label>`, add a 64-team option matching the existing pattern:

```html
<label class="size-option" data-size="64">
  <input type="radio" name="size" value="64">
  <span class="size-num">64</span>
  <span class="size-label">teams</span>
  <span class="size-tag pro">Pro</span>
</label>
```

Also update the upgrade note text (line 216-217) from `$2.99` to reflect the new per-bracket pricing:

```html
<p id="size-upgrade-note" class="size-upgrade-note hidden">
  16, 32 &amp; 64-team brackets require payment. <a href="#" id="size-upgrade-link">See pricing</a>
</p>
```

- [ ] **Step 3: Verify by creating a 64-team bracket locally**

Start the server, log in as a pro user (manually set tier='pro' in the DB for testing), create a 64-team bracket, add 64 participants via bulk add, start it, and verify:
- Two-sided layout renders
- Round labels show NCAA names
- Zoom-to-fit produces legible view

- [ ] **Step 4: Commit**

```bash
git add public/app.js public/index.html
git commit -m "feat: 64-team round labels and size option in UI"
```

---

### Task 9: Payment modal frontend

**Files:**
- Modify: `public/index.html` (new modal HTML), `public/app.js` (payment logic), `public/style.css` (modal styles)

- [ ] **Step 1: Add payment modal HTML**

In `index.html`, before the closing `</body>`, add:

```html
<!-- Payment Modal -->
<div id="payment-modal" class="modal-overlay hidden" role="dialog" aria-modal="true">
  <div class="modal-box payment-modal-box">
    <h3>Unlock <span id="payment-size">16</span>-Team Brackets</h3>
    <div class="payment-options">
      <div class="payment-option">
        <div class="payment-option-title">This Bracket</div>
        <div class="payment-option-price" id="payment-per-price">$1.99</div>
        <div class="payment-option-desc">One-time, just this bracket</div>
        <button class="btn btn-primary" id="pay-per-bracket-btn">Pay Now</button>
      </div>
      <div class="payment-option payment-option-recommended">
        <div class="payment-badge">Best Value</div>
        <div class="payment-option-title">Lifetime Pro</div>
        <div class="payment-option-price">$14.99</div>
        <div class="payment-option-desc">Unlimited 16, 32, & 64-team brackets forever</div>
        <button class="btn btn-gold" id="pay-lifetime-btn">Get Lifetime Pro</button>
      </div>
    </div>
    <button class="btn btn-ghost btn-sm" id="payment-cancel-btn">Cancel</button>
  </div>
</div>
```

- [ ] **Step 2: Add payment modal styles**

In `public/style.css`, add:

```css
/* ─── Payment Modal ──────────────────────────────────────────────── */
.payment-modal-box { max-width: 520px; text-align: center; }
.payment-options { display: flex; gap: 16px; margin: 20px 0; }
.payment-option {
  flex: 1;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: 20px 16px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}
.payment-option-recommended {
  border-color: var(--gold);
  position: relative;
}
.payment-badge {
  position: absolute;
  top: -10px;
  background: var(--gold);
  color: var(--bg);
  font-size: 11px;
  font-weight: 700;
  padding: 2px 10px;
  border-radius: 10px;
  letter-spacing: 0.5px;
}
.payment-option-title { font-weight: 700; font-size: 14px; }
.payment-option-price { font-size: 28px; font-weight: 800; color: var(--gold); }
.payment-option-desc { font-size: 12px; color: var(--text-2); }
@media (max-width: 480px) { .payment-options { flex-direction: column; } }
```

- [ ] **Step 3: Add payment modal logic in app.js**

In `public/app.js`, find the bracket creation form submit handler (line 293-312). Replace the existing try/catch inside the submit handler:

```js
$('create-form').addEventListener('submit', async e => {
  e.preventDefault();
  hide('create-error');
  const title = $('b-title').value.trim();
  const size = Number(document.querySelector('.size-option.selected')?.dataset.size || 8);
  if (!title) return;
  try {
    const data = await api('POST', '/api/brackets', { title, size });
    // If server returns checkoutUrl, bracket is pending_payment — show payment modal
    if (data.checkoutUrl) {
      state.pendingBracket = data;
      const priceMap = { 16: '$1.99', 32: '$3.99', 64: '$4.99' };
      $('payment-size').textContent = data.size;
      $('payment-per-price').textContent = priceMap[data.size] || '$4.99';
      closeCreateModal();
      show('payment-modal');
      return;
    }
    closeCreateModal();
    await showManageView(data.slug);
  } catch (err) {
    $('create-error').textContent = err.message;
    show('create-error');
  }
});
```

Add click handlers:

```js
$('pay-per-bracket-btn').addEventListener('click', () => {
  if (state.pendingBracket?.checkoutUrl) {
    window.location.href = state.pendingBracket.checkoutUrl;
  }
});

$('pay-lifetime-btn').addEventListener('click', async () => {
  try {
    const data = await api('POST', '/api/checkout/lifetime');
    if (data.url) window.location.href = data.url;
  } catch (e) {
    alert('Checkout failed: ' + e.message);
  }
});

$('payment-cancel-btn').addEventListener('click', () => {
  hide('payment-modal');
  state.pendingBracket = null;
});
```

- [ ] **Step 4: Update the existing Pro upgrade banner and pricing references**

In `index.html`, update the upgrade banner text (line 65-69):
- Change `$2.99` to `$14.99` in both the banner text and the size-upgrade-note
- Change banner copy to: `<strong>Unlock Pro</strong> — unlimited 16, 32 &amp; 64-team brackets for a one-time payment of <strong>$14.99</strong>`

In `app.js`, find the existing `Upgrade Now` button handler (the one calling `/api/checkout` or `startCheckout()`). Change it to call `/api/checkout/lifetime` instead:

```js
$('upgrade-btn').addEventListener('click', async () => {
  try {
    const data = await api('POST', '/api/checkout/lifetime');
    if (data.url) window.location.href = data.url;
  } catch (e) {
    alert('Checkout failed: ' + e.message);
  }
});
```

Also update the `$2.99` reference in the create-error handler (line 305) — remove the old `startCheckout()` error path since the payment modal now handles this.

- [ ] **Step 5: Commit**

```bash
git add public/index.html public/app.js public/style.css
git commit -m "feat: payment modal with per-bracket and lifetime options"
```

---

### Task 10: Password reset frontend

**Files:**
- Modify: `public/index.html`, `public/app.js`

- [ ] **Step 1: Add forgot-password link to login form**

In `index.html`, after the `#auth-submit` button in the auth form, add:

```html
<p class="forgot-link"><a href="#" id="forgot-password-link">Forgot password?</a></p>
```

- [ ] **Step 2: Add forgot-password inline form**

Below the auth form, add:

```html
<div id="forgot-password-form" class="hidden" style="margin-top: 16px;">
  <p class="form-label" style="margin-bottom: 8px;">Enter your email and we'll send a reset link.</p>
  <div class="field-row">
    <input type="email" id="forgot-email" placeholder="you@example.com" required>
    <button class="btn btn-primary btn-sm" id="forgot-submit">Send Link</button>
  </div>
  <div id="forgot-msg" class="hidden" style="margin-top: 8px; color: var(--success);">Check your email for a reset link.</div>
  <div id="forgot-error" class="form-error hidden"></div>
</div>
```

- [ ] **Step 3: Add reset-password view**

In `index.html`, add a new view section (hidden by default) alongside the other views:

```html
<div id="reset-password-view" class="hidden auth-container">
  <h2>Reset Password</h2>
  <div class="field-row" style="flex-direction: column; gap: 12px;">
    <input type="password" id="reset-new-password" placeholder="New password (12+ characters)" minlength="12">
    <button class="btn btn-primary" id="reset-submit">Reset Password</button>
  </div>
  <div id="reset-msg" class="hidden" style="margin-top: 8px; color: var(--success);"></div>
  <div id="reset-error" class="form-error hidden"></div>
</div>
```

- [ ] **Step 4: Add JS handlers**

In `public/app.js`:

```js
// Forgot password
$('forgot-password-link').addEventListener('click', e => {
  e.preventDefault();
  show('forgot-password-form');
});

$('forgot-submit').addEventListener('click', async () => {
  hide('forgot-error'); hide('forgot-msg');
  const email = $('forgot-email').value.trim();
  if (!email) return;
  try {
    await api('POST', '/api/forgot-password', { email });
    show('forgot-msg');
  } catch (e) {
    $('forgot-error').textContent = e.message;
    show('forgot-error');
  }
});

// Reset password (from email link — token is in URL query param: /reset-password?token=xxx)
$('reset-submit').addEventListener('click', async () => {
  hide('reset-error'); hide('reset-msg');
  const password = $('reset-new-password').value;
  const params = new URLSearchParams(window.location.search);
  const token = params.get('token');
  if (!token) { $('reset-error').textContent = 'Invalid reset link'; show('reset-error'); return; }
  try {
    await api('POST', '/api/reset-password', { token, password });
    $('reset-msg').textContent = 'Password reset! You can now sign in.';
    show('reset-msg');
  } catch (e) {
    $('reset-error').textContent = e.message;
    show('reset-error');
  }
});
```

- [ ] **Step 5: Add reset-password route to the router and VIEWS**

Add `'reset-password-view'` to the `VIEWS` array (line 73):

```js
const VIEWS = ['auth-view', 'dashboard-view', 'manage-view', 'bracket-view', 'landing', 'reset-password-view'];
```

In the `route()` function (line 82), add a check for the reset-password path before the slug lookup:

```js
async function route(path) {
  path = path || window.location.pathname;
  const slug = path.replace(/^\//, '').replace(/\/$/, '');

  // Reset password route
  if (slug === 'reset-password') {
    showView('reset-password');
    return;
  }

  if (!slug || slug === '') {
    // ... existing logic
  }
  // ... rest of router
}
```

- [ ] **Step 6: Commit**

```bash
git add public/index.html public/app.js
git commit -m "feat: forgot password and reset password UI"
```

---

### Task 11: NCAA template button in frontend

**Files:**
- Modify: `public/app.js`, `public/index.html`

- [ ] **Step 1: Add NCAA button in new-bracket form**

In `index.html`, in the new bracket creation section, add a button:

```html
<button class="btn btn-gold btn-sm hidden" id="ncaa-template-btn">🏀 Use 2026 NCAA Field</button>
```

- [ ] **Step 2: Check template availability on dashboard load**

In `app.js`, when loading the dashboard, check:

```js
// After loading brackets list
try {
  const ncaa = await api('GET', '/api/ncaa-template');
  setHidden('ncaa-template-btn', !ncaa.available);
} catch { setHidden('ncaa-template-btn', true); }
```

- [ ] **Step 3: Handle NCAA button click**

```js
$('ncaa-template-btn').addEventListener('click', async () => {
  try {
    const data = await api('POST', '/api/brackets/ncaa');
    if (data.requiresPayment && data.checkoutUrl) {
      // Show payment modal with per-bracket vs lifetime choice
      state.pendingBracket = { ...data, size: 64 };
      $('payment-size').textContent = '64';
      $('payment-per-price').textContent = '$4.99';
      show('payment-modal');
    } else {
      navigate('/manage/' + data.slug);
    }
  } catch (e) {
    alert('Failed: ' + e.message);
  }
});
```

- [ ] **Step 4: Commit**

```bash
git add public/index.html public/app.js
git commit -m "feat: NCAA 2026 template button on dashboard"
```

---

## Chunk 3: Landing Page

### Task 12: Build the landing page

**Files:**
- Modify: `public/index.html` (new `<section id="landing">`), `public/style.css` (landing styles), `public/app.js` (show/hide logic)

- [ ] **Step 1: Add landing page HTML**

In `index.html`, immediately after `<body>`, before the first view div, add the full landing section:

```html
<section id="landing" class="landing hidden">
  <!-- Hero -->
  <div class="landing-hero">
    <div class="landing-logo">🏆</div>
    <h1>Brackets for everything.<br>Built in minutes.</h1>
    <p class="landing-sub">Create single-elimination brackets for any tournament — sports, games, anything. Share a link. Let the crowd vote.</p>
    <div class="landing-ctas">
      <button class="btn btn-gold btn-lg" id="landing-signup-btn">Create Free Bracket</button>
      <a href="#pricing" class="btn btn-ghost btn-lg">See Pricing</a>
    </div>
  </div>

  <!-- Format Showcase -->
  <div class="landing-section">
    <h2>Any size. Any tournament.</h2>
    <div class="landing-formats">
      <div class="format-card">
        <div class="format-size">8</div>
        <div class="format-label">Team</div>
        <div class="format-price">Free</div>
      </div>
      <div class="format-card">
        <div class="format-size">16</div>
        <div class="format-label">Team</div>
        <div class="format-price">$1.99</div>
      </div>
      <div class="format-card">
        <div class="format-size">32</div>
        <div class="format-label">Team</div>
        <div class="format-price">$3.99</div>
      </div>
      <div class="format-card format-card-highlight">
        <div class="format-size">64</div>
        <div class="format-label">Team</div>
        <div class="format-price">$4.99</div>
      </div>
    </div>
  </div>

  <!-- NCAA Banner -->
  <div id="ncaa-banner" class="landing-ncaa hidden">
    <span>🏀 2026 NCAA Tournament bracket — fill yours out now</span>
    <button class="btn btn-gold btn-sm" id="ncaa-banner-btn">Get Started</button>
  </div>

  <!-- Features -->
  <div class="landing-section">
    <h2>Everything you need</h2>
    <div class="landing-features">
      <div class="feature-item"><div class="feature-icon">🔗</div><div class="feature-title">Public Sharing</div><div class="feature-desc">Share a link — anyone can view your bracket</div></div>
      <div class="feature-item"><div class="feature-icon">✓</div><div class="feature-title">Live Crowd Voting</div><div class="feature-desc">Let your audience vote on matchups in real time</div></div>
      <div class="feature-item"><div class="feature-icon">📷</div><div class="feature-title">Image Uploads</div><div class="feature-desc">Add images to participants for visual brackets</div></div>
      <div class="feature-item"><div class="feature-icon">⬇</div><div class="feature-title">Export PNG/PDF</div><div class="feature-desc">Download high-res bracket images or print</div></div>
    </div>
  </div>

  <!-- Pricing -->
  <div class="landing-section" id="pricing">
    <h2>Simple pricing</h2>
    <div class="landing-pricing">
      <div class="pricing-col">
        <div class="pricing-tier">Free</div>
        <div class="pricing-amount">$0</div>
        <ul class="pricing-features">
          <li>Unlimited 8-team brackets</li>
          <li>Public sharing</li>
          <li>Crowd voting</li>
          <li>PNG/PDF export</li>
        </ul>
        <button class="btn btn-ghost" id="pricing-free-btn">Get Started</button>
      </div>
      <div class="pricing-col">
        <div class="pricing-tier">Per Bracket</div>
        <div class="pricing-amount">$1.99 <span class="pricing-per">–$4.99</span></div>
        <ul class="pricing-features">
          <li>16, 32, or 64-team brackets</li>
          <li>Pay once per bracket</li>
          <li>Everything in Free</li>
        </ul>
        <button class="btn btn-ghost" id="pricing-perbracket-btn">Create a Bracket</button>
      </div>
      <div class="pricing-col pricing-col-highlight">
        <div class="pricing-badge">Best Value</div>
        <div class="pricing-tier">Lifetime Pro</div>
        <div class="pricing-amount">$14.99</div>
        <ul class="pricing-features">
          <li>Unlimited large brackets</li>
          <li>16, 32, and 64-team</li>
          <li>One-time payment, forever</li>
          <li>Everything in Free</li>
        </ul>
        <button class="btn btn-gold" id="pricing-lifetime-btn">Get Lifetime Pro</button>
      </div>
    </div>
  </div>

  <!-- Footer -->
  <footer class="landing-footer">
    <span>Bracket Builder</span>
    <span>·</span>
    <a href="#">Terms</a>
    <span>·</span>
    <a href="#">Privacy</a>
    <span>·</span>
    <a href="mailto:support@bracketbuilder.app">Contact</a>
  </footer>
</section>
```

- [ ] **Step 2: Add landing page CSS**

Add to `public/style.css`:

```css
/* ─── Landing Page ───────────────────────────────────────────────── */
.landing { max-width: 960px; margin: 0 auto; padding: 0 24px; }

.landing-hero {
  text-align: center;
  padding: 80px 0 60px;
}
.landing-logo { font-size: 48px; margin-bottom: 16px; }
.landing-hero h1 {
  font-size: 40px;
  font-weight: 800;
  line-height: 1.15;
  margin-bottom: 16px;
}
.landing-sub {
  font-size: 18px;
  color: var(--text-2);
  max-width: 520px;
  margin: 0 auto 32px;
  line-height: 1.5;
}
.landing-ctas { display: flex; gap: 12px; justify-content: center; }
.btn-lg { padding: 14px 32px; font-size: 16px; }

.landing-section {
  padding: 48px 0;
  text-align: center;
}
.landing-section h2 {
  font-size: 24px;
  font-weight: 700;
  margin-bottom: 28px;
}

/* Format cards */
.landing-formats { display: flex; gap: 16px; justify-content: center; flex-wrap: wrap; }
.format-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: 28px 24px;
  min-width: 120px;
  text-align: center;
}
.format-card-highlight { border-color: var(--gold); }
.format-size { font-size: 36px; font-weight: 800; color: var(--gold); }
.format-label { font-size: 14px; color: var(--text-2); margin-bottom: 8px; }
.format-price { font-size: 16px; font-weight: 700; }

/* NCAA banner */
.landing-ncaa {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 16px;
  background: var(--gold-dim);
  border: 1px solid var(--gold);
  border-radius: var(--radius-lg);
  padding: 16px 24px;
  margin: 0 0 24px;
  flex-wrap: wrap;
}

/* Features grid */
.landing-features { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 24px; max-width: 720px; margin: 0 auto; }
.feature-item { text-align: center; }
.feature-icon { font-size: 28px; margin-bottom: 8px; }
.feature-title { font-weight: 700; font-size: 15px; margin-bottom: 4px; }
.feature-desc { font-size: 13px; color: var(--text-2); }

/* Pricing */
.landing-pricing { display: flex; gap: 16px; justify-content: center; flex-wrap: wrap; }
.pricing-col {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: 28px 24px;
  min-width: 200px;
  max-width: 260px;
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  position: relative;
}
.pricing-col-highlight { border-color: var(--gold); }
.pricing-badge {
  position: absolute;
  top: -10px;
  background: var(--gold);
  color: var(--bg);
  font-size: 11px;
  font-weight: 700;
  padding: 2px 12px;
  border-radius: 10px;
}
.pricing-tier { font-weight: 700; font-size: 16px; margin-bottom: 4px; }
.pricing-amount { font-size: 32px; font-weight: 800; color: var(--gold); margin-bottom: 12px; }
.pricing-per { font-size: 16px; font-weight: 400; color: var(--text-2); }
.pricing-features { list-style: none; font-size: 13px; color: var(--text-2); margin-bottom: 16px; line-height: 2; }
.pricing-features li::before { content: "✓ "; color: var(--success); }

.landing-footer {
  text-align: center;
  padding: 32px 0;
  font-size: 13px;
  color: var(--text-3);
  display: flex;
  gap: 8px;
  justify-content: center;
}
.landing-footer a { color: var(--text-2); text-decoration: none; }
.landing-footer a:hover { color: var(--gold); }

@media (max-width: 640px) {
  .landing-hero h1 { font-size: 28px; }
  .landing-sub { font-size: 15px; }
  .landing-ctas { flex-direction: column; align-items: center; }
  .landing-pricing { flex-direction: column; align-items: center; }
  .pricing-col { max-width: 100%; width: 100%; }
}
```

- [ ] **Step 3: Add landing page show/hide logic**

In `public/app.js`, integrate the landing page into the view system:

1. Add `'landing'` to the `VIEWS` array so it gets hidden automatically:

```js
const VIEWS = ['auth-view', 'dashboard-view', 'manage-view', 'bracket-view', 'landing', 'reset-password-view'];
```

2. Modify `showAuth()` to show the landing page instead of the auth form for logged-out users:

```js
function showAuth() {
  if (!state.user) {
    showView('landing');
  } else {
    showView('auth');
  }
}
```

This way `showView()` automatically hides the landing page when navigating to dashboard/manage/bracket views.

Add NCAA banner date check:

```js
// Show NCAA banner between March 15 and April 7, 2026
(function() {
  const now = new Date();
  const start = new Date('2026-03-15');
  const end = new Date('2026-04-08');
  if (now >= start && now < end) show('ncaa-banner');
})();
```

Add click handlers for landing page buttons:

```js
$('landing-signup-btn')?.addEventListener('click', () => {
  hide('landing');
  show('auth-view');
  // Switch to Create Account tab
  document.querySelector('.auth-tab[data-tab="register"]')?.click();
});

$('ncaa-banner-btn')?.addEventListener('click', () => {
  hide('landing');
  show('auth-view');
});

$('pricing-free-btn')?.addEventListener('click', () => {
  hide('landing');
  show('auth-view');
});

$('pricing-perbracket-btn')?.addEventListener('click', () => {
  hide('landing');
  show('auth-view');
});

$('pricing-lifetime-btn')?.addEventListener('click', async () => {
  if (!state.user) {
    hide('landing');
    show('auth-view');
    return;
  }
  try {
    const data = await api('POST', '/api/checkout/lifetime');
    if (data.url) window.location.href = data.url;
  } catch (e) {
    alert('Checkout failed: ' + e.message);
  }
});
```

- [ ] **Step 4: Take a screenshot and verify layout**

Start the server, open in browser, verify logged-out user sees the landing page with hero, format cards, features, pricing table, and footer.

- [ ] **Step 5: Commit**

```bash
git add public/index.html public/app.js public/style.css
git commit -m "feat: landing page with hero, format showcase, features, and pricing table"
```

---

## Chunk 4: Deployment & Smoke Test

### Task 13: Railway deployment preparation

**Files:**
- Verify: `nixpacks.toml`, `package.json`, `server.js`

This is manual setup, not code changes.

- [ ] **Step 1: Create Railway project**

1. Go to railway.app → New Project → Deploy from GitHub repo (or `railway init` CLI)
2. Attach a Volume: Settings → Volumes → Add Volume → mount path: `/app/data`
3. Set env vars in Railway dashboard (all vars from spec)

- [ ] **Step 2: Create Stripe test products**

1. Go to Stripe Dashboard (test mode) → Products
2. Create 4 products with one-time prices:
   - "Per Bracket 16-Team" — $1.99
   - "Per Bracket 32-Team" — $3.99
   - "Per Bracket 64-Team" — $4.99
   - "Lifetime Pro" — $14.99
3. Copy each price ID (`price_xxx`) to Railway env vars: `STRIPE_PRICE_16`, `STRIPE_PRICE_32`, `STRIPE_PRICE_64`, `STRIPE_PRICE_LIFETIME`

- [ ] **Step 3: Create Stripe webhook**

1. Stripe Dashboard → Developers → Webhooks → Add endpoint
2. URL: `https://your-domain/api/webhook`
3. Events: select `checkout.session.completed` only
4. Copy signing secret to Railway env var: `STRIPE_WEBHOOK_SECRET`

- [ ] **Step 4: Create Cloudflare R2 bucket**

1. Cloudflare Dashboard → R2 → Create bucket (e.g. `bracket-builder`)
2. Enable public access: Settings → Public Access → Allow
3. Copy the public bucket URL (e.g. `https://pub-xxx.r2.dev`)
4. Create API token: R2 → Manage R2 API tokens → Create API token → Object Read & Write
5. Copy credentials to Railway env vars

- [ ] **Step 5: Create Resend account**

1. Sign up at resend.com
2. Add and verify your domain
3. Copy API key → set as `RESEND_SMTP_PASS` in Railway
4. Set `RESEND_SMTP_USER` to `resend`

- [ ] **Step 6: Push to main and deploy**

```bash
git checkout main
git merge feature-parity
git push origin main
```

Railway auto-builds and deploys.

- [ ] **Step 7: Point custom domain**

1. Railway → Settings → Custom Domain → add your domain
2. Add CNAME record in Cloudflare DNS pointing to Railway

---

### Task 14: Smoke test

- [ ] **Step 1: Run through the complete smoke test checklist from the spec**

Test each item on the deployed production URL (using Stripe test mode):

1. Register new account → lands on dashboard
2. Create 8-team bracket → no payment, status='setup'
3. Create 16-team bracket as free user → payment modal appears
4. Complete per-bracket checkout with test card `4242 4242 4242 4242` → bracket unlocked
5. Cancel a Stripe checkout → bracket doesn't show in dashboard
6. Complete lifetime checkout → user.tier='pro'
7. Create 64-team bracket as pro user → no payment prompt
8. Start bracket, advance matchups through all rounds
9. Share bracket URL in incognito → public view works
10. Vote as anonymous user → 409 on duplicate
11. Forgot password → email arrives → reset works
12. Upload participant image → image loads from R2 URL
13. Export PNG → renders correctly
14. Hit `/api/vote` 11 times → 429 on 11th

- [ ] **Step 2: Switch to live Stripe keys**

Once all tests pass:
1. Create the same 4 products in Stripe live mode
2. Create live webhook endpoint
3. Update Railway env vars: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_*`

- [ ] **Step 3: Final verification with a real $1.99 test purchase**

Make an actual purchase to verify real payments flow end-to-end. Refund it afterwards in Stripe dashboard.

---

### Task 15: NCAA template population (March 15)

**Files:**
- Modify: `data/ncaa-2026.json`

- [ ] **Step 1: After Selection Sunday, populate the template**

Watch Selection Sunday (March 15), then fill `data/ncaa-2026.json` with all 64 teams. Format:

```json
[
  { "name": "Team Name", "seed": 1, "region": "East" },
  { "name": "Team Name", "seed": 2, "region": "East" },
  ...
]
```

Each region (East, West, South, Midwest) has seeds 1–16. Total: 64 entries.

- [ ] **Step 2: Push and verify**

```bash
git add data/ncaa-2026.json
git commit -m "feat: populate NCAA 2026 bracket field"
git push origin main
```

Railway auto-deploys. Verify: dashboard shows the NCAA template button, clicking it creates a 64-team bracket with all teams.
