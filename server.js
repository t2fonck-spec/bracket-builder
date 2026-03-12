'use strict';
const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const multer = require('multer');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const r2 = process.env.R2_ACCOUNT_ID ? new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
}) : null;

const app = express();
app.set('trust proxy', 1);
const DB_PATH = process.env.DB_PATH || './data/brackets.db';
const fs = require('fs');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-please-change-in-production';
const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY;
const stripe = STRIPE_SECRET ? require('stripe')(STRIPE_SECRET) : null;
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

const transporter = process.env.RESEND_SMTP_PASS ? require('nodemailer').createTransport({
  host: 'smtp.resend.com',
  port: 465,
  secure: true,
  auth: { user: process.env.RESEND_SMTP_USER || 'resend', pass: process.env.RESEND_SMTP_PASS },
}) : null;

// ─── Schema ──────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT    UNIQUE NOT NULL,
    password_hash TEXT    NOT NULL,
    tier          TEXT    NOT NULL DEFAULT 'free',
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    email_verified INTEGER NOT NULL DEFAULT 1,
    verification_token TEXT
  );

  CREATE TABLE IF NOT EXISTS brackets (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL,
    title       TEXT    NOT NULL,
    slug        TEXT    UNIQUE NOT NULL,
    size        INTEGER NOT NULL DEFAULT 8,
    is_paid     INTEGER NOT NULL DEFAULT 0,
    status      TEXT    NOT NULL DEFAULT 'setup',
    description TEXT,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS participants (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    bracket_id INTEGER NOT NULL,
    name       TEXT    NOT NULL,
    img        TEXT,
    seed       INTEGER NOT NULL,
    FOREIGN KEY (bracket_id) REFERENCES brackets(id)
  );

  CREATE TABLE IF NOT EXISTS matchups (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    bracket_id        INTEGER NOT NULL,
    round             INTEGER NOT NULL,
    position          INTEGER NOT NULL,
    participant_a_id  INTEGER,
    participant_b_id  INTEGER,
    winner_id         INTEGER,
    score_a           INTEGER,
    score_b           INTEGER,
    FOREIGN KEY (bracket_id) REFERENCES brackets(id)
  );

  CREATE TABLE IF NOT EXISTS votes (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    bracket_id     INTEGER NOT NULL,
    matchup_id     INTEGER NOT NULL,
    voter_token    TEXT    NOT NULL,
    participant_id INTEGER NOT NULL,
    created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(matchup_id, voter_token),
    FOREIGN KEY (bracket_id)    REFERENCES brackets(id),
    FOREIGN KEY (matchup_id)    REFERENCES matchups(id)
  );
`);

// ─── Migrations (idempotent) ──────────────────────────────────────────────────
['ALTER TABLE matchups ADD COLUMN score_a INTEGER',
 'ALTER TABLE matchups ADD COLUMN score_b INTEGER',
 'ALTER TABLE brackets ADD COLUMN description TEXT',
 'ALTER TABLE users ADD COLUMN reset_token TEXT',
 'ALTER TABLE users ADD COLUMN reset_token_expires INTEGER',
].forEach(sql => { try { db.exec(sql); } catch {} });

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use('/api/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Rate Limiters ────────────────────────────────────────────────────────────
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

// ─── Upload Setup ─────────────────────────────────────────────────────────────
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

// ─── Auth Routes ─────────────────────────────────────────────────────────────
app.post('/api/register', authLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  if (password.length < 12) return res.status(400).json({ error: 'Password must be at least 12 characters' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const normalEmail = email.toLowerCase().trim();
    const row = db.prepare('INSERT INTO users (email, password_hash, email_verified) VALUES (?, ?, 1)').run(normalEmail, hash);
    
    const user = { id: row.lastInsertRowid, email: normalEmail, tier: 'free' };
    const token = jwt.sign(user, JWT_SECRET, { expiresIn: '30d' });
    res.status(201).json({ token, user });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Email already registered' });
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/login', authLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  const row = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase().trim());
  if (!row) return res.status(401).json({ error: 'Invalid credentials' });
  const valid = await bcrypt.compare(password, row.password_hash);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
  
  const user = { id: row.id, email: row.email, tier: row.tier };
  const token = jwt.sign(user, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user });
});

app.get('/api/me', auth, (req, res) => {
  const row = db.prepare('SELECT id, email, tier FROM users WHERE id = ?').get(req.user.id);
  res.json(row);
});

app.post('/api/forgot-password', authLimiter, async (req, res) => {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Email required' });
  // Always return ok to avoid leaking whether email exists
  res.json({ ok: true });
  // Send reset email in background
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase().trim());
  if (!user || !transporter) return;
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  db.prepare('UPDATE users SET reset_token = ?, reset_token_expires = ? WHERE id = ?')
    .run(tokenHash, Date.now() + 3600000, user.id);
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

app.post('/api/reset-password', async (req, res) => {
  const { token, password } = req.body || {};
  if (!token || !password) return res.status(400).json({ error: 'Token and password required' });
  if (password.length < 12) return res.status(400).json({ error: 'Password must be at least 12 characters' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const user = db.prepare('SELECT * FROM users WHERE reset_token = ? AND reset_token_expires > ?')
    .get(tokenHash, Date.now());
  if (!user) return res.status(400).json({ error: 'Invalid or expired reset link' });
  const hash = await bcrypt.hash(password, 10);
  db.prepare('UPDATE users SET password_hash = ?, reset_token = NULL, reset_token_expires = NULL WHERE id = ?')
    .run(hash, user.id);
  res.json({ ok: true });
});

app.get('/verify/:token', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE verification_token = ?').get(req.params.token);
  if (!user) return res.redirect('/?verify_error=1');
  db.prepare('UPDATE users SET email_verified = 1, verification_token = NULL WHERE id = ?').run(user.id);
  const jwtUser = { id: user.id, email: user.email, tier: user.tier };
  const token = jwt.sign(jwtUser, JWT_SECRET, { expiresIn: '30d' });
  res.redirect(`/?verified=1&token=${token}`);
});

// ─── Image Upload ─────────────────────────────────────────────────────────────
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

// ─── Bracket Routes ───────────────────────────────────────────────────────────
app.get('/api/brackets', auth, (req, res) => {
  const rows = db.prepare(`
    SELECT b.*, COUNT(p.id) as participant_count
    FROM brackets b
    LEFT JOIN participants p ON p.bracket_id = b.id
    WHERE b.user_id = ? AND b.status != 'pending_payment'
    GROUP BY b.id
    ORDER BY b.created_at DESC
  `).all(req.user.id);
  res.json(rows);
});

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
  if (!stripe) return res.status(503).json({ error: 'Payments not configured' });

  try {
    const row = db.prepare('INSERT INTO brackets (user_id, title, slug, size, status) VALUES (?, ?, ?, ?, ?)')
      .run(req.user.id, title.trim(), slug, bracketSize, 'pending_payment');
    const bracketId = row.lastInsertRowid;

    const priceMap = { 16: process.env.STRIPE_PRICE_16, 32: process.env.STRIPE_PRICE_32, 64: process.env.STRIPE_PRICE_64 };
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{ price: priceMap[bracketSize], quantity: 1 }],
      mode: 'payment',
      success_url: `${BASE_URL}/${slug}?payment=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${BASE_URL}/?payment=cancelled`,
      metadata: { bracket_id: String(bracketId), user_id: String(req.user.id), purchase_type: 'per_bracket' },
    });

    res.status(201).json({ id: bracketId, title: title.trim(), slug, size: bracketSize, status: 'pending_payment', checkoutUrl: session.url });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to create bracket' });
  }
});

// ─── NCAA Template ────────────────────────────────────────────────────────────
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
    if (!stripe) return res.status(503).json({ error: 'Payments not configured' });
    try {
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        line_items: [{ price: process.env.STRIPE_PRICE_64, quantity: 1 }],
        mode: 'payment',
        success_url: `${BASE_URL}/${slug}?payment=success`,
        cancel_url: `${BASE_URL}/?payment=cancelled`,
        metadata: { bracket_id: String(bracketId), user_id: String(req.user.id), purchase_type: 'per_bracket' },
      });
      return res.json({ slug, checkoutUrl: session.url, requiresPayment: true });
    } catch (e) {
      console.error('Stripe error:', e.message);
      return res.status(500).json({ error: 'Stripe checkout failed' });
    }
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

app.get('/api/brackets/:slug', optionalAuth, (req, res) => {
  const bracket = db.prepare('SELECT * FROM brackets WHERE slug = ?').get(req.params.slug);
  if (!bracket) return res.status(404).json({ error: 'Bracket not found' });

  const participants = db.prepare('SELECT * FROM participants WHERE bracket_id = ? ORDER BY seed').all(bracket.id);

  const matchups = db.prepare('SELECT * FROM matchups WHERE bracket_id = ? ORDER BY round, position').all(bracket.id);
  const votesByMatchup = db.prepare(`
    SELECT matchup_id, participant_id, COUNT(*) as count
    FROM votes WHERE bracket_id = ?
    GROUP BY matchup_id, participant_id
  `).all(bracket.id);

  const votesMap = {};
  for (const v of votesByMatchup) {
    if (!votesMap[v.matchup_id]) votesMap[v.matchup_id] = {};
    votesMap[v.matchup_id][v.participant_id] = v.count;
  }

  const matchupsWithVotes = matchups.map(m => ({
    ...m,
    score_a: m.score_a ?? null,
    score_b: m.score_b ?? null,
    votes: votesMap[m.id] || {}
  }));

  const isOwner = req.user?.id === bracket.user_id;
  res.json({ bracket, participants, matchups: matchupsWithVotes, isOwner });
});

app.delete('/api/brackets/:id', auth, (req, res) => {
  const bracket = db.prepare('SELECT * FROM brackets WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!bracket) return res.status(404).json({ error: 'Not found' });
  db.transaction(() => {
    db.prepare('DELETE FROM votes WHERE bracket_id = ?').run(bracket.id);
    db.prepare('DELETE FROM matchups WHERE bracket_id = ?').run(bracket.id);
    db.prepare('DELETE FROM participants WHERE bracket_id = ?').run(bracket.id);
    db.prepare('DELETE FROM brackets WHERE id = ?').run(bracket.id);
  })();
  res.json({ ok: true });
});

// ─── Participant Routes ───────────────────────────────────────────────────────
app.post('/api/brackets/:slug/participants', auth, (req, res) => {
  const bracket = db.prepare('SELECT * FROM brackets WHERE slug = ? AND user_id = ?').get(req.params.slug, req.user.id);
  if (!bracket) return res.status(404).json({ error: 'Not found' });
  if (bracket.status !== 'setup') return res.status(400).json({ error: 'Cannot add participants after bracket has started' });

  const count = db.prepare('SELECT COUNT(*) as c FROM participants WHERE bracket_id = ?').get(bracket.id).c;
  if (count >= bracket.size) return res.status(400).json({ error: `Maximum ${bracket.size} participants reached` });

  const { name, img } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ error: 'Name required' });

  const seed = count + 1;
  const row = db.prepare('INSERT INTO participants (bracket_id, name, img, seed) VALUES (?, ?, ?, ?)').run(bracket.id, name.trim(), img?.trim() || null, seed);
  res.status(201).json({ id: row.lastInsertRowid, bracket_id: bracket.id, name: name.trim(), img: img?.trim() || null, seed });
});

app.delete('/api/brackets/:slug/participants/:id', auth, (req, res) => {
  const bracket = db.prepare('SELECT * FROM brackets WHERE slug = ? AND user_id = ?').get(req.params.slug, req.user.id);
  if (!bracket) return res.status(404).json({ error: 'Not found' });
  if (bracket.status !== 'setup') return res.status(400).json({ error: 'Cannot remove participants after bracket has started' });
  db.prepare('DELETE FROM participants WHERE id = ? AND bracket_id = ?').run(req.params.id, bracket.id);
  res.json({ ok: true });
});

// ─── Bracket Start ────────────────────────────────────────────────────────────
const SEEDINGS = {
  8:  [[1,8],[4,5],[3,6],[2,7]],
  16: [[1,16],[8,9],[5,12],[4,13],[6,11],[3,14],[7,10],[2,15]],
  32: [[1,32],[16,17],[8,25],[9,24],[5,28],[12,21],[13,20],[4,29],
       [3,30],[14,19],[11,22],[6,27],[7,26],[10,23],[15,18],[2,31]],
  64: [[1,16],[8,9],[5,12],[4,13],[6,11],[3,14],[7,10],[2,15],
       [17,32],[24,25],[21,28],[20,29],[22,27],[19,30],[23,26],[18,31],
       [33,48],[40,41],[37,44],[36,45],[38,43],[35,46],[39,42],[34,47],
       [49,64],[56,57],[53,60],[52,61],[54,59],[51,62],[55,58],[50,63]]
};

app.post('/api/brackets/:slug/start', auth, (req, res) => {
  const bracket = db.prepare('SELECT * FROM brackets WHERE slug = ? AND user_id = ?').get(req.params.slug, req.user.id);
  if (!bracket) return res.status(404).json({ error: 'Not found' });
  if (bracket.status !== 'setup') return res.status(400).json({ error: 'Bracket already started' });

  const participants = db.prepare('SELECT * FROM participants WHERE bracket_id = ? ORDER BY seed').all(bracket.id);
  if (participants.length !== bracket.size) {
    return res.status(400).json({ error: `Need exactly ${bracket.size} participants (have ${participants.length})` });
  }

  const seedings = SEEDINGS[bracket.size];
  const insert = db.prepare('INSERT INTO matchups (bracket_id, round, position, participant_a_id, participant_b_id) VALUES (?, ?, ?, ?, ?)');
  const totalRounds = Math.log2(bracket.size);

  db.transaction(() => {
    // Round 1 — seeded matchups
    seedings.forEach((pair, i) => {
      const pA = participants.find(p => p.seed === pair[0]);
      const pB = participants.find(p => p.seed === pair[1]);
      insert.run(bracket.id, 1, i + 1, pA.id, pB.id);
    });
    // Subsequent rounds — empty placeholder matchups
    for (let r = 2; r <= totalRounds; r++) {
      const count = bracket.size / Math.pow(2, r);
      for (let pos = 1; pos <= count; pos++) {
        insert.run(bracket.id, r, pos, null, null);
      }
    }
    db.prepare('UPDATE brackets SET status = ? WHERE id = ?').run('active', bracket.id);
  })();

  res.json({ ok: true });
});

// ─── Vote ─────────────────────────────────────────────────────────────────────
app.post('/api/brackets/:slug/vote', voteLimiter, (req, res) => {
  const bracket = db.prepare('SELECT * FROM brackets WHERE slug = ?').get(req.params.slug);
  if (!bracket) return res.status(404).json({ error: 'Not found' });
  if (bracket.status !== 'active') return res.status(400).json({ error: 'Bracket is not accepting votes' });

  const { matchup_id, participant_id } = req.body || {};
  if (!matchup_id || !participant_id) return res.status(400).json({ error: 'matchup_id and participant_id required' });

  // Strict multi-tenant scoping — verify matchup belongs to this bracket
  const matchup = db.prepare('SELECT * FROM matchups WHERE id = ? AND bracket_id = ?').get(matchup_id, bracket.id);
  if (!matchup) return res.status(404).json({ error: 'Matchup not found in this bracket' });
  if (matchup.winner_id) return res.status(400).json({ error: 'This matchup has already been decided' });
  if (!matchup.participant_a_id || !matchup.participant_b_id) return res.status(400).json({ error: 'Matchup not ready yet' });

  if (Number(participant_id) !== matchup.participant_a_id && Number(participant_id) !== matchup.participant_b_id) {
    return res.status(400).json({ error: 'Participant is not in this matchup' });
  }

  // Per-matchup voter token (IP-based, prevents double-voting per matchup)
  const voterToken = crypto.createHash('sha256').update((req.ip || 'anon') + '|' + matchup_id).digest('hex');

  try {
    db.prepare('INSERT INTO votes (bracket_id, matchup_id, voter_token, participant_id) VALUES (?, ?, ?, ?)')
      .run(bracket.id, matchup_id, voterToken, participant_id);
    res.json({ ok: true });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'You have already voted in this matchup' });
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Advance Matchup (owner only) ─────────────────────────────────────────────
app.post('/api/brackets/:slug/advance', auth, (req, res) => {
  const bracket = db.prepare('SELECT * FROM brackets WHERE slug = ? AND user_id = ?').get(req.params.slug, req.user.id);
  if (!bracket) return res.status(404).json({ error: 'Not found' });
  if (bracket.status === 'complete') return res.status(400).json({ error: 'Bracket is already complete' });

  const { matchup_id, winner_id } = req.body || {};
  const matchup = db.prepare('SELECT * FROM matchups WHERE id = ? AND bracket_id = ?').get(matchup_id, bracket.id);
  if (!matchup) return res.status(404).json({ error: 'Matchup not found' });
  if (matchup.winner_id) return res.status(400).json({ error: 'Matchup already has a winner' });

  if (Number(winner_id) !== matchup.participant_a_id && Number(winner_id) !== matchup.participant_b_id) {
    return res.status(400).json({ error: 'Winner must be a participant in this matchup' });
  }

  const totalRounds = Math.log2(bracket.size);

  db.transaction(() => {
    db.prepare('UPDATE matchups SET winner_id = ? WHERE id = ?').run(winner_id, matchup_id);

    if (matchup.round < totalRounds) {
      const nextRound = matchup.round + 1;
      const nextPosition = Math.ceil(matchup.position / 2);
      const nextMatchup = db.prepare('SELECT * FROM matchups WHERE bracket_id = ? AND round = ? AND position = ?')
        .get(bracket.id, nextRound, nextPosition);

      if (nextMatchup) {
        // Odd position → slot A, even position → slot B
        if (matchup.position % 2 === 1) {
          db.prepare('UPDATE matchups SET participant_a_id = ? WHERE id = ?').run(winner_id, nextMatchup.id);
        } else {
          db.prepare('UPDATE matchups SET participant_b_id = ? WHERE id = ?').run(winner_id, nextMatchup.id);
        }
      }
    } else {
      // Final round complete — check if all matchups in final round are done
      const pending = db.prepare('SELECT COUNT(*) as c FROM matchups WHERE bracket_id = ? AND winner_id IS NULL').get(bracket.id).c;
      if (pending === 0) {
        db.prepare('UPDATE brackets SET status = ? WHERE id = ?').run('complete', bracket.id);
      }
    }
  })();

  res.json({ ok: true });
});

// ─── Update Bracket metadata (title / description) ───────────────────────────
app.patch('/api/brackets/:slug', auth, (req, res) => {
  const bracket = db.prepare('SELECT * FROM brackets WHERE slug = ? AND user_id = ?').get(req.params.slug, req.user.id);
  if (!bracket) return res.status(404).json({ error: 'Not found' });
  const { title, description } = req.body || {};
  const newTitle = title?.trim() || bracket.title;
  const newDesc  = description !== undefined ? (description?.trim() || null) : bracket.description;
  db.prepare('UPDATE brackets SET title = ?, description = ? WHERE id = ?').run(newTitle, newDesc, bracket.id);
  res.json({ ok: true, title: newTitle, description: newDesc });
});

// ─── Set Matchup Scores (owner only) ─────────────────────────────────────────
app.patch('/api/brackets/:slug/matchups/:id', auth, (req, res) => {
  const bracket = db.prepare('SELECT * FROM brackets WHERE slug = ? AND user_id = ?').get(req.params.slug, req.user.id);
  if (!bracket) return res.status(404).json({ error: 'Not found' });
  const matchup = db.prepare('SELECT * FROM matchups WHERE id = ? AND bracket_id = ?').get(req.params.id, bracket.id);
  if (!matchup) return res.status(404).json({ error: 'Matchup not found' });

  const { score_a, score_b } = req.body || {};
  const sa = score_a !== undefined && score_a !== null && score_a !== '' ? Number(score_a) : matchup.score_a;
  const sb = score_b !== undefined && score_b !== null && score_b !== '' ? Number(score_b) : matchup.score_b;
  db.prepare('UPDATE matchups SET score_a = ?, score_b = ? WHERE id = ?').run(sa ?? null, sb ?? null, matchup.id);
  res.json({ ok: true, score_a: sa, score_b: sb });
});

// ─── Bulk Add Participants ────────────────────────────────────────────────────
app.post('/api/brackets/:slug/participants/bulk', auth, (req, res) => {
  const bracket = db.prepare('SELECT * FROM brackets WHERE slug = ? AND user_id = ?').get(req.params.slug, req.user.id);
  if (!bracket) return res.status(404).json({ error: 'Not found' });
  if (bracket.status !== 'setup') return res.status(400).json({ error: 'Bracket already started' });

  const { names } = req.body || {};
  if (!Array.isArray(names) || !names.length) return res.status(400).json({ error: 'names array required' });

  const existing = db.prepare('SELECT COUNT(*) as c FROM participants WHERE bracket_id = ?').get(bracket.id).c;
  const slots = bracket.size - existing;
  if (slots <= 0) return res.status(400).json({ error: `Bracket is full (${bracket.size} participants)` });

  const toAdd = names.map(n => n.trim()).filter(Boolean).slice(0, slots);
  const insert = db.prepare('INSERT INTO participants (bracket_id, name, seed) VALUES (?, ?, ?)');

  const added = db.transaction(() => {
    return toAdd.map((name, i) => {
      const seed = existing + i + 1;
      const row = insert.run(bracket.id, name, seed);
      return { id: row.lastInsertRowid, name, seed };
    });
  })();

  res.status(201).json({ added });
});

// ─── Shuffle Participant Seeding ──────────────────────────────────────────────
app.post('/api/brackets/:slug/participants/shuffle', auth, (req, res) => {
  const bracket = db.prepare('SELECT * FROM brackets WHERE slug = ? AND user_id = ?').get(req.params.slug, req.user.id);
  if (!bracket) return res.status(404).json({ error: 'Not found' });
  if (bracket.status !== 'setup') return res.status(400).json({ error: 'Cannot shuffle after bracket has started' });

  const participants = db.prepare('SELECT id FROM participants WHERE bracket_id = ?').all(bracket.id);
  // Fisher-Yates shuffle of seeds
  const seeds = participants.map((_, i) => i + 1);
  for (let i = seeds.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [seeds[i], seeds[j]] = [seeds[j], seeds[i]];
  }
  const update = db.prepare('UPDATE participants SET seed = ? WHERE id = ?');
  db.transaction(() => participants.forEach((p, i) => update.run(seeds[i], p.id)))();
  res.json({ ok: true });
});

// ─── Reorder Participant (drag-drop) ─────────────────────────────────────────
app.patch('/api/brackets/:slug/participants/:id/seed', auth, (req, res) => {
  const bracket = db.prepare('SELECT * FROM brackets WHERE slug = ? AND user_id = ?').get(req.params.slug, req.user.id);
  if (!bracket) return res.status(404).json({ error: 'Not found' });
  if (bracket.status !== 'setup') return res.status(400).json({ error: 'Cannot reorder after bracket has started' });

  const { new_seed } = req.body || {};
  if (!new_seed) return res.status(400).json({ error: 'new_seed required' });

  const target = db.prepare('SELECT * FROM participants WHERE id = ? AND bracket_id = ?').get(req.params.id, bracket.id);
  if (!target) return res.status(404).json({ error: 'Participant not found' });

  const oldSeed = target.seed;
  const ns = Number(new_seed);

  // Shift seeds to make room
  db.transaction(() => {
    if (ns < oldSeed) {
      db.prepare('UPDATE participants SET seed = seed + 1 WHERE bracket_id = ? AND seed >= ? AND seed < ?').run(bracket.id, ns, oldSeed);
    } else {
      db.prepare('UPDATE participants SET seed = seed - 1 WHERE bracket_id = ? AND seed > ? AND seed <= ?').run(bracket.id, oldSeed, ns);
    }
    db.prepare('UPDATE participants SET seed = ? WHERE id = ?').run(ns, target.id);
  })();

  res.json({ ok: true });
});

// ─── Rollback Matchup (owner only) ───────────────────────────────────────────
app.post('/api/brackets/:slug/rollback', auth, (req, res) => {
  const bracket = db.prepare('SELECT * FROM brackets WHERE slug = ? AND user_id = ?').get(req.params.slug, req.user.id);
  if (!bracket) return res.status(404).json({ error: 'Not found' });

  const { matchup_id } = req.body || {};
  const matchup = db.prepare('SELECT * FROM matchups WHERE id = ? AND bracket_id = ?').get(matchup_id, bracket.id);
  if (!matchup) return res.status(404).json({ error: 'Matchup not found' });
  if (!matchup.winner_id) return res.status(400).json({ error: 'Matchup has no winner to roll back' });

  // Collect the full forward chain to clear (cascade downstream)
  const totalRounds = Math.log2(bracket.size);
  const toRollback = []; // [{ matchup, slot: 'a'|'b'|null }]

  function collectChain(m) {
    toRollback.push(m);
    if (m.round >= totalRounds) return;
    const nextRound = m.round + 1;
    const nextPos   = Math.ceil(m.position / 2);
    const next = db.prepare('SELECT * FROM matchups WHERE bracket_id = ? AND round = ? AND position = ?')
      .get(bracket.id, nextRound, nextPos);
    // Only follow if next matchup actually received this winner
    if (next && (next.participant_a_id === m.winner_id || next.participant_b_id === m.winner_id)) {
      collectChain(next);
    }
  }
  collectChain(matchup);

  db.transaction(() => {
    for (let i = 0; i < toRollback.length; i++) {
      const m = toRollback[i];
      // Clear this matchup's winner
      db.prepare('UPDATE matchups SET winner_id = NULL WHERE id = ?').run(m.id);

      // Clear the slot this winner occupied in the next round
      if (i + 1 < toRollback.length) {
        const next = toRollback[i + 1];
        // Also wipe next matchup's participants entirely so it's back to TBD
        if (next.participant_a_id === m.winner_id) {
          db.prepare('UPDATE matchups SET participant_a_id = NULL WHERE id = ?').run(next.id);
        } else if (next.participant_b_id === m.winner_id) {
          db.prepare('UPDATE matchups SET participant_b_id = NULL WHERE id = ?').run(next.id);
        }
      }
    }
    // If bracket was marked complete, reopen it
    if (bracket.status === 'complete') {
      db.prepare('UPDATE brackets SET status = ? WHERE id = ?').run('active', bracket.id);
    }
  })();

  res.json({ ok: true, rolledBack: toRollback.length });
});

// ─── Stripe Checkout ──────────────────────────────────────────────────────────
app.post('/api/checkout/lifetime', auth, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Payments not configured' });
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

// ─── Verify Payment (called on success redirect to avoid webhook race) ───────
app.post('/api/verify-payment', auth, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Payments not configured' });
  const { session_id } = req.body;
  if (!session_id) return res.status(400).json({ error: 'Missing session_id' });
  try {
    const session = await stripe.checkout.sessions.retrieve(session_id);
    if (session.payment_status !== 'paid') return res.json({ status: 'pending' });
    const purchaseType = session.metadata?.purchase_type;
    if (purchaseType === 'per_bracket') {
      const bracketId = parseInt(session.metadata?.bracket_id, 10);
      if (bracketId) {
        db.prepare('UPDATE brackets SET is_paid = 1, status = ? WHERE id = ? AND status = ?')
          .run('setup', bracketId, 'pending_payment');
      }
      return res.json({ status: 'paid', bracket_id: bracketId });
    } else if (purchaseType === 'lifetime') {
      const userId = parseInt(session.metadata?.user_id, 10);
      if (userId) db.prepare('UPDATE users SET tier = ? WHERE id = ?').run('pro', userId);
      return res.json({ status: 'paid', tier: 'pro' });
    }
    res.json({ status: 'paid' });
  } catch (e) {
    console.error('verify-payment error:', e.message);
    res.status(500).json({ error: 'Verification failed' });
  }
});

// ─── Stripe Webhook ───────────────────────────────────────────────────────────
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
    if (session.payment_status !== 'paid') return res.json({ received: true });
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

// ─── SPA Fallback ─────────────────────────────────────────────────────────────
app.get('/reset-password', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/:slug', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bracket Builder running on http://localhost:${PORT}`));
