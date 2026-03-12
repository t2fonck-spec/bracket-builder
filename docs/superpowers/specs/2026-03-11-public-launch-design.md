# Bracket Builder — Public Launch Design

**Date:** 2026-03-11
**Status:** Approved
**Deadline:** 2026-03-18 (before NCAA tournament tip-off March 19)

---

## Overview

Ship the existing Bracket Builder app as a public, monetized product on Railway. The core single-elimination product is feature-complete. This spec covers the delta work required to go from local dev to a revenue-generating public product.

**Scope:** Deploy & monetize what exists, plus 64-team support and an NCAA 2026 autofill template to capitalize on March Madness timing.

**Out of scope:** Double elimination, group stage, round robin (future roadmap).

---

## Target Audience

Broad — general consumers (office pools, friend groups), hobbyist communities (gaming/anime tournaments), and small organizers (sports leagues, schools). No single niche. The NCAA template specifically targets the March Madness audience during launch week.

---

## Infrastructure

### Railway
- Single Node.js service, auto-deploy from `main` branch
- Railway Volume at `/app/data` — SQLite database persists across deploys
- `nixpacks.toml` pins Node 20 + python3 (required for better-sqlite3 native build)
- Start command: `node server.js`
- `DB_PATH=/app/data/brackets.db`

### Cloudflare R2 (image storage)
- Replaces current multer disk storage (`public/uploads/`)
- AWS S3-compatible API via `@aws-sdk/client-s3`
- Free tier: 10GB storage, 1M writes/month, zero egress fees
- Images served from R2 public bucket URL (e.g. `https://pub-xxx.r2.dev/filename.jpg`)
- Uploaded images survive deploys and volume issues independently
- No migration of existing dev uploads needed (no production data exists yet)
- Old `/uploads/` static route removed from Express once R2 is live

### Email (Password Reset)
- Provider: **Resend** (resend.com) — free tier 3,000 emails/month, simple REST API, reliable deliverability
- Nodemailer already imported; configure with Resend SMTP credentials

### Environment Variables
```
JWT_SECRET                 # 64-char random string
STRIPE_SECRET_KEY          # Stripe live secret key
STRIPE_WEBHOOK_SECRET      # Stripe webhook signing secret
STRIPE_PRICE_16            # Stripe price ID for $1.99 per-bracket (16-team)
STRIPE_PRICE_32            # Stripe price ID for $3.99 per-bracket (32-team)
STRIPE_PRICE_64            # Stripe price ID for $4.99 per-bracket (64-team)
STRIPE_PRICE_LIFETIME      # Stripe price ID for $14.99 lifetime
BASE_URL                   # https://your-domain.com
DB_PATH                    # /app/data/brackets.db
R2_ACCOUNT_ID
R2_ACCESS_KEY_ID
R2_SECRET_ACCESS_KEY
R2_BUCKET_NAME
R2_PUBLIC_URL              # Public R2 bucket base URL (no trailing slash)
RESEND_SMTP_USER           # resend (literal string)
RESEND_SMTP_PASS           # Resend API key (re_xxxx)
```

---

## Existing Features (already built, no changes needed)

- Single-elimination bracket CRUD (create, manage, delete)
- Bracket sizes: 8, 16, 32-team (two-sided NCAA-style layout)
- Participant management: add, bulk add, delete, shuffle seeds, drag-reorder
- Matchup advance/rollback, score entry
- **Voting:** Any anonymous user can vote in active matchups. One vote per matchup per IP, enforced server-side via SHA-256 hash of `ip + matchup_id` stored in `votes.voter_token`. No login required to vote.
- **Public sharing:** Every bracket is publicly viewable by its slug URL (`/:slug`). No privacy toggle — all brackets are public. Owner-only actions (advance, rollback, manage) require JWT auth.
- Image upload (being migrated from disk to R2)
- Two-sided bracket layout, pan/zoom, settings popover, theme toggle, champion modal, export PNG/JPG/PDF
- Tier system: `users.tier` = `'free'` or `'pro'`; `brackets.is_paid` column for per-bracket purchases

---

## Pricing Model

| Tier | Price | What you get |
|------|-------|--------------|
| Free | $0 | Unlimited 8-team brackets |
| Per bracket (16-team) | $1.99 one-time | That specific bracket, forever |
| Per bracket (32-team) | $3.99 one-time | That specific bracket, forever |
| Per bracket (64-team) | $4.99 one-time | That specific bracket, forever |
| Lifetime Pro | **$14.99** one-time | Unlimited 16/32/64-team brackets, forever |

### Anchoring Rationale
At $1.99/bracket, lifetime breaks even after 8 sixteen-teamers. At $3.99, after 4 thirty-two-teamers. This ratio nudges power users toward the higher-value lifetime purchase while still converting casual one-off users via per-bracket pricing.

### Per-Bracket Payment Flow (exact sequence)

1. Free user selects 16, 32, or 64-team bracket size and enters a title
2. Frontend calls `POST /api/brackets` — server creates bracket with `status='pending_payment'`, `is_paid=0`, returns `{ id, slug, checkoutUrl }` where `checkoutUrl` is a Stripe Checkout session URL
3. Stripe Checkout session is created with:
   - `price`: the appropriate `STRIPE_PRICE_*` env var
   - `metadata.bracket_id`: the new bracket's ID
   - `metadata.purchase_type`: `'per_bracket'`
   - `success_url`: `${BASE_URL}/manage/:slug?payment=success`
   - `cancel_url`: `${BASE_URL}/?payment=cancelled` (bracket left in pending_payment, cleaned up by a future cron or ignored)
4. User completes Stripe Checkout
5. Stripe fires `checkout.session.completed` webhook
6. Webhook handler reads `metadata.purchase_type`:
   - `'per_bracket'`: sets `brackets.is_paid=1`, `brackets.status='setup'` for `metadata.bracket_id`
   - `'lifetime'`: sets `users.tier='pro'` for `metadata.user_id`
7. User lands on `/manage/:slug` — bracket is now in setup status, ready to use
8. If user cancels checkout: bracket stays `pending_payment`. On dashboard load, filter out `status='pending_payment'` brackets from the list. Optionally clean them up after 24h.

### Lifetime Payment Flow
1. User clicks "Get Lifetime Pro" from pricing modal or landing page
2. `POST /api/checkout/lifetime` creates Stripe session with `metadata.user_id` and `metadata.purchase_type='lifetime'`
3. On `checkout.session.completed`: set `users.tier='pro'`
4. Redirect to `/?upgraded=1`

### Gate Logic
- At `POST /api/brackets`: if `size > 8` AND `user.tier !== 'pro'`, create bracket as `pending_payment` and return Stripe checkout URL instead of normal `201` response
- Pro users: bracket created normally as `status='setup'`, `is_paid=1`
- 8-team brackets: always free, created normally

### Stripe Products Required (create in Stripe dashboard before launch)
- `price_per_bracket_16` — $1.99 USD, one-time
- `price_per_bracket_32` — $3.99 USD, one-time
- `price_per_bracket_64` — $4.99 USD, one-time
- `price_lifetime_pro` — $14.99 USD, one-time

---

## New Features

### 64-Team Bracket Support
- Add `64` to valid bracket sizes `[8, 16, 32, 64]`
- First-round seedings: 4 regions × 8 matchups = 32 first-round games using global seeds 1–64:

```js
SEEDINGS[64] = [
  // East: global seeds 1–16, positions 1–8 (left upper)
  [1,16],[8,9],[5,12],[4,13],[6,11],[3,14],[7,10],[2,15],
  // West: global seeds 17–32, positions 9–16 (left lower)
  [17,32],[24,25],[21,28],[20,29],[22,27],[19,30],[23,26],[18,31],
  // South: global seeds 33–48, positions 17–24 (right upper)
  [33,48],[40,41],[37,44],[36,45],[38,43],[35,46],[39,42],[34,47],
  // Midwest: global seeds 49–64, positions 25–32 (right lower)
  [49,64],[56,57],[53,60],[52,61],[54,59],[51,62],[55,58],[50,63]
]
```

- **Region-to-position mapping** (determines left/right side and vertical slot):
  - East: positions 1–8 (left side, upper half)
  - West: positions 9–16 (left side, lower half)
  - South: positions 17–24 (right side, upper half)
  - Midwest: positions 25–32 (right side, lower half)
  - Final Four: East/West winner (left semi, position 1), South/Midwest winner (right semi, position 2)
- 6 rounds total, named: `{ 1: 'Round of 64', 2: 'Round of 32', 3: 'Sweet 16', 4: 'Elite Eight', 5: 'Final Four', 6: 'Championship' }`
- Round labels override `nameMap` in `renderRoundLabels()` when `bracket.size === 64`
- **Advance math is correct as-is:** `Math.ceil(position / 2)` produces the right next-round position for all positions including the right side (e.g. position 17 → 9, position 32 → 16). The two-sided layout is purely visual; the data model uses sequential positions throughout. No changes to advance/rollback logic needed.
- Layout: `calcTwosidedLayout()` is pure math and scales to 64 teams. Rendered width at full scale ≈ 2,688px — zoom-to-fit handles this. Verify legibility at 1280px viewport width during implementation.
- Add `pending_payment` to dashboard filter: `WHERE status != 'pending_payment'` in `GET /api/brackets`.

### NCAA 2026 Template
- `data/ncaa-2026.json` — array of 64 objects: `{ name: string, seed: number, region: 'East'|'West'|'South'|'Midwest' }`
- Populated manually after Selection Sunday (March 15, 2026). File ships empty/placeholder until then.
- `GET /api/ncaa-template` — returns the JSON contents; returns `{ available: false }` if file is empty/unpopulated
- `POST /api/brackets/ncaa` — auth required; creates a 64-team bracket titled "NCAA Tournament 2026", seeds all 64 teams using region-to-position mapping above, returns the new bracket slug
- "Use 2026 NCAA Field" button on new-bracket screen — calls `/api/brackets/ncaa`, redirects to manage page
- Button only shown when `GET /api/ncaa-template` returns `{ available: true }`
- Bracket created in `setup` status — owner can reseed/shuffle before starting
- 64-team bracket requires payment for non-pro users (same gate as above)

### Rate Limiting
- `express-rate-limit` on `POST /api/vote`: 10 requests/minute per IP
- `express-rate-limit` on `POST /api/login` and `POST /api/register`: 5 requests/15 minutes per IP
- Returns `429` with `{ error: 'Too many requests, please try again later' }`
- Rate limiting is in addition to (not a replacement for) the existing `voter_token` deduplication

### Password Reset
- DB migration: `ALTER TABLE users ADD COLUMN reset_token TEXT`, `ALTER TABLE users ADD COLUMN reset_token_expires INTEGER` (Unix timestamp)
- `POST /api/forgot-password` — body: `{ email }`. Looks up user, generates 32-byte hex token, sets `reset_token` + `reset_token_expires = now + 3600000`, sends email via nodemailer/Resend with link `${BASE_URL}/reset-password?token=xxx`. Always returns `{ ok: true }` (don't reveal whether email exists).
- `POST /api/reset-password` — body: `{ token, password }`. Validates token exists and `reset_token_expires > Date.now()`, enforces `password.length >= 12`, updates `password_hash`, clears `reset_token` + `reset_token_expires`.
- Frontend: "Forgot password?" link below login form → inline form with email input → success message. Separate `/reset-password` view (hash route) with new password form, token read from URL query param.

---

## Landing Page

Single `<section id="landing">` prepended inside `index.html`. Shown when `state.user === null`; hidden once logged in. No separate deploy or routing needed.

**Headline:** "Brackets for everything. Built in minutes."
**Subheadline:** "Create single-elimination brackets for any tournament — sports, games, anything. Share a link. Let the crowd vote."

**Structure (top to bottom):**
1. **Hero** — headline, subheadline, two CTAs: "Create Free Bracket" (primary gold button, scrolls to auth form) + "See Pricing" (ghost button, scrolls to pricing section)
2. **Format showcase** — four cards: 8-team (Free), 16-team ($1.99), 32-team ($3.99), 64-team ($4.99) — each showing the bracket size and a small bracket icon/preview
3. **NCAA callout banner** — "🏀 2026 NCAA Tournament bracket — fill yours out now" with a CTA button. Shown only between March 15–April 7, 2026 (hardcoded date range check in JS). Hidden outside that window.
4. **Features row** — four items: "Public sharing" (link icon), "Live crowd voting" (checkmark), "Image uploads" (photo icon), "Export PNG/PDF" (download icon)
5. **Pricing table** — three columns: Free / Per Bracket / Lifetime Pro ($14.99). Lifetime column has gold border + "Best Value" badge. Each column lists what's included.
6. **Footer** — Terms of Service link, Privacy Policy link, contact email

---

## Deployment Workflow

### Pre-Launch Steps (in order)
1. Create Cloudflare R2 bucket, enable public access, copy credentials
2. Create Railway project, attach Volume at `/app/data`
3. Create Stripe products and copy price IDs
4. Set all env vars in Railway dashboard
5. Register Stripe webhook endpoint in Stripe dashboard: `https://your-domain/api/webhook`, event: `checkout.session.completed`
6. Create `nixpacks.toml`, push `main` → Railway builds and deploys
7. Point custom domain CNAME to Railway

### NCAA Template Deployment (March 15–18)
1. Selection Sunday (March 15): copy the full 64-team field with seeds and regions
2. Populate `data/ncaa-2026.json`
3. Push to `main` → Railway auto-deploys (~2 min)
4. Smoke test: click "Use 2026 NCAA Field" → bracket created with all 64 teams

### Smoke Test Checklist
- [ ] Register new account → lands on dashboard
- [ ] Create 8-team bracket → no payment, status='setup'
- [ ] Create 16-team bracket as free user → payment modal with per-bracket ($1.99) and lifetime ($14.99)
- [ ] Complete per-bracket Stripe checkout → bracket unlocked, status='setup', is_paid=1
- [ ] Cancel Stripe checkout → bracket not shown in dashboard
- [ ] Complete lifetime Stripe checkout → user.tier='pro', no payment prompt on future large brackets
- [ ] Use NCAA 2026 template → 64-team bracket created with all teams, correct seeds
- [ ] Start bracket, advance matchups → winner propagates correctly through 6 rounds
- [ ] Share bracket URL in incognito → public view works, vote buttons visible
- [ ] Vote as anonymous user → vote recorded; vote again same matchup → 409 duplicate error
- [ ] Forgot password → email received at Resend → reset link works
- [ ] Upload participant image → served from R2 URL (not /uploads/)
- [ ] Export PNG → renders correctly at full bracket size
- [ ] Rate limit: hit /api/vote 11 times/min → 429 on 11th

---

## Files to Create / Modify

### New files
- `nixpacks.toml`
- `data/ncaa-2026.json` (placeholder until Selection Sunday)

### Modified files
- `server.js` — R2 upload, rate limiting, password reset, per-bracket payment flow, 64-team seedings, NCAA template endpoint, `pending_payment` status handling
- `public/index.html` — landing page section, payment modal, forgot/reset-password UI
- `public/app.js` — payment modal logic, NCAA template button, 64-team round labels, pending_payment bracket filtering, reset-password hash route
- `public/style.css` — landing page styles, pricing table, payment modal, NCAA banner
- `package.json` — add `@aws-sdk/client-s3`, `express-rate-limit`

---

## What's Explicitly Out of Scope

- Email verification on register (adds signup friction, can add post-launch)
- Analytics (add Plausible/Umami post-launch)
- CI/CD pipeline beyond Railway auto-deploy
- Double elimination, group stage, round robin (future roadmap)
- Mobile app
- Bracket privacy settings (all brackets are public)
- Pending-payment bracket cleanup cron job (nice-to-have, not blocking)
