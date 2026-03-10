'use strict';
const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const crypto = require('crypto');

const app = express();
const DB_PATH = process.env.DB_PATH || './data/brackets.db';
const fs = require('fs');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-please-change-in-production';
const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY;
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

// ─── Schema ──────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT    UNIQUE NOT NULL,
    password_hash TEXT    NOT NULL,
    tier          TEXT    NOT NULL DEFAULT 'free',
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS brackets (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL,
    title      TEXT    NOT NULL,
    slug       TEXT    UNIQUE NOT NULL,
    size       INTEGER NOT NULL DEFAULT 8,
    is_paid    INTEGER NOT NULL DEFAULT 0,
    status     TEXT    NOT NULL DEFAULT 'setup',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
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

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use('/api/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.user = jwt.verify(header.slice(7), JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function optionalAuth(req, res, next) {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    try { req.user = jwt.verify(header.slice(7), JWT_SECRET); } catch {}
  }
  next();
}

// ─── Auth Routes ─────────────────────────────────────────────────────────────
app.post('/api/register', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const row = db.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)').run(email.toLowerCase().trim(), hash);
    const user = { id: row.lastInsertRowid, email: email.toLowerCase().trim(), tier: 'free' };
    const token = jwt.sign(user, JWT_SECRET, { expiresIn: '30d' });
    res.status(201).json({ token, user });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Email already registered' });
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/login', async (req, res) => {
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

// ─── Bracket Routes ───────────────────────────────────────────────────────────
app.get('/api/brackets', auth, (req, res) => {
  const rows = db.prepare(`
    SELECT b.*, COUNT(p.id) as participant_count
    FROM brackets b
    LEFT JOIN participants p ON p.bracket_id = b.id
    WHERE b.user_id = ?
    GROUP BY b.id
    ORDER BY b.created_at DESC
  `).all(req.user.id);
  res.json(rows);
});

app.post('/api/brackets', auth, (req, res) => {
  const { title, size } = req.body || {};
  if (!title?.trim()) return res.status(400).json({ error: 'Title required' });
  const bracketSize = [8, 16, 32].includes(Number(size)) ? Number(size) : 8;

  if (bracketSize > 8 && req.user.tier === 'free') {
    return res.status(403).json({ error: 'Pro tier required for 16 and 32-team brackets', upgrade: true });
  }

  const slug = title.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
    + '-' + crypto.randomBytes(3).toString('hex');

  try {
    const row = db.prepare('INSERT INTO brackets (user_id, title, slug, size) VALUES (?, ?, ?, ?)').run(req.user.id, title.trim(), slug, bracketSize);
    res.status(201).json({ id: row.lastInsertRowid, title: title.trim(), slug, size: bracketSize, status: 'setup', participant_count: 0 });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to create bracket' });
  }
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
       [3,30],[14,19],[11,22],[6,27],[7,26],[10,23],[15,18],[2,31]]
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
app.post('/api/brackets/:slug/vote', (req, res) => {
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

// ─── Stripe Checkout ──────────────────────────────────────────────────────────
app.post('/api/checkout', auth, async (req, res) => {
  if (!STRIPE_SECRET) return res.status(503).json({ error: 'Stripe is not configured on this server' });

  const stripe = require('stripe')(STRIPE_SECRET);
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: 'Bracket Builder Pro',
            description: 'Unlock 16 & 32-team brackets with unlimited voting',
          },
          unit_amount: 299, // $2.99
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `${BASE_URL}/?upgraded=1`,
      cancel_url: `${BASE_URL}/?cancelled=1`,
      metadata: { user_id: String(req.user.id) },
    });
    res.json({ url: session.url });
  } catch (e) {
    console.error('Stripe error:', e.message);
    res.status(500).json({ error: 'Stripe checkout failed' });
  }
});

// ─── Stripe Webhook ───────────────────────────────────────────────────────────
app.post('/api/webhook', (req, res) => {
  if (!STRIPE_SECRET || !process.env.STRIPE_WEBHOOK_SECRET) return res.status(400).send('Not configured');
  const stripe = require('stripe')(STRIPE_SECRET);
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    return res.status(400).send(`Webhook error: ${e.message}`);
  }
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const userId = parseInt(session.metadata?.user_id, 10);
    if (userId) db.prepare('UPDATE users SET tier = ? WHERE id = ?').run('pro', userId);
  }
  res.json({ received: true });
});

// ─── SPA Fallback ─────────────────────────────────────────────────────────────
app.get('/:slug', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bracket Builder running on http://localhost:${PORT}`));
