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
- Images served from R2 public bucket URL
- Uploaded images survive deploys and volume issues independently

### Environment Variables
```
JWT_SECRET                 # 64-char random string
STRIPE_SECRET_KEY          # Stripe live secret key
STRIPE_WEBHOOK_SECRET      # Stripe webhook signing secret
BASE_URL                   # https://your-domain.com
DB_PATH                    # /app/data/brackets.db
R2_ACCOUNT_ID
R2_ACCESS_KEY_ID
R2_SECRET_ACCESS_KEY
R2_BUCKET_NAME
R2_PUBLIC_URL              # Public R2 bucket base URL
```

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
At $1.99/bracket, lifetime breaks even after 8 sixteen-teamers. At $3.99, after 4 thirty-two-teamers. This ratio consistently nudges power users toward the higher-value lifetime purchase while still converting casual one-off users via per-bracket pricing.

### Payment Flow
When a free user tries to create a 16, 32, or 64-team bracket, a modal appears showing both options side-by-side: per-bracket price (left) and Lifetime Pro (right), with Lifetime visually emphasized as "Best Value." Two separate Stripe Checkout sessions.

### Stripe Products Required
- `price_per_bracket_16` — $1.99 one-time payment
- `price_per_bracket_32` — $3.99 one-time payment
- `price_per_bracket_64` — $4.99 one-time payment
- `price_lifetime_pro` — $14.99 one-time payment

### Implementation
- `brackets.is_paid = 1` set by webhook for per-bracket purchases (Stripe metadata carries `pending_bracket_id`)
- `users.tier = 'pro'` set by webhook for lifetime purchases (existing mechanism)
- Gate at bracket creation: check `size > 8 && user.tier !== 'pro' && !bracket.is_paid`

---

## New Features

### 64-Team Bracket Support
- Add `64` to valid bracket sizes `[8, 16, 32, 64]`
- First-round seedings: 4 regions × 8 matchups = 32 first-round games
  - Per region: 1v16, 8v9, 5v12, 4v13, 6v11, 3v14, 7v10, 2v15
  - Positions 1–32 (left side), positions 33–64 (right side) in two-sided layout
- 6 rounds total: Round of 64, Round of 32, Sweet 16, Elite 8, Final Four, Championship
- Round label names: `{ 6: 'Championship', 5: 'Final Four', 4: 'Elite Eight', 3: 'Sweet 16', 2: 'Round of 32', 1: 'Round of 64' }`
- Two-sided layout already scales correctly via `calcTwosidedLayout()` — no layout changes needed

### NCAA 2026 Template
- `data/ncaa-2026.json` — hardcoded team list populated after Selection Sunday (March 15)
- Format: array of `{ name, seed, region }` for all 64 teams
- "Use 2026 NCAA Field" button on new-bracket screen creates a 64-team bracket with all teams pre-seeded, preserving region groupings in seed order
- Template can be updated and redeployed without code changes
- Bracket is created in `setup` status — owner can reseed/shuffle before starting

### Rate Limiting
- `express-rate-limit` on `/api/vote`: 10 votes/minute per IP
- `express-rate-limit` on `/api/login` and `/api/register`: 5 requests/15 minutes per IP
- Returns `429` with `{ error: 'Too many requests' }`

### Password Reset
- `POST /api/forgot-password` — generates `reset_token` (32-byte hex), stores with 1-hour expiry in users table, sends email via nodemailer with reset link
- `POST /api/reset-password` — validates token + expiry, updates `password_hash`, clears token
- DB migration: `ALTER TABLE users ADD COLUMN reset_token TEXT`, `ADD COLUMN reset_token_expires INTEGER`
- UI: "Forgot password?" link on login form → email input → confirmation message

---

## Landing Page

Single HTML section prepended to the existing `index.html`. Shown when user is logged out; replaced by the dashboard when logged in. No separate deploy or routing needed.

**Headline:** "Brackets for everything. Built in minutes."

**Structure (top to bottom):**
1. **Hero** — headline + subheadline + two CTAs: "Create Free Bracket" (primary) + "View Pricing" (secondary)
2. **Format showcase** — three cards showing 8-team (Free), 16-team (Pro), 32-team (Pro) with visual bracket preview
3. **NCAA callout banner** — "🏀 2026 NCAA Tournament bracket — fill yours out now" (conditionally shown; hide after tournament ends)
4. **Features row** — four icons: Public sharing, Live voting, Image uploads, Export PNG/PDF
5. **Pricing table** — three columns: Free / Per Bracket / Lifetime Pro — Lifetime column highlighted with "Best Value" badge
6. **Footer** — Terms of Service, Privacy Policy, Contact links

---

## Deployment Workflow

### Pre-Launch Steps
1. Create Cloudflare R2 bucket with public access
2. Create Railway project, attach Volume at `/app/data`
3. Set all env vars in Railway dashboard
4. Register Stripe webhook endpoint (`https://your-domain/api/webhook`)
5. Create Stripe products and price IDs, add to env vars
6. Create `nixpacks.toml`, push `main` branch

### NCAA Template Flow
1. Selection Sunday (March 15): teams announced
2. Populate `data/ncaa-2026.json` with the full 64-team field
3. Push to `main` → Railway auto-deploys
4. Smoke test NCAA template creation
5. Deploy by Wednesday March 18

### Smoke Test Checklist
- [ ] Register new account
- [ ] Create 8-team bracket (free, no payment)
- [ ] Create 16-team bracket → payment modal appears → per-bracket Stripe checkout → `is_paid = 1`
- [ ] Create account, pay lifetime → `tier = 'pro'` → create 32-team bracket without payment prompt
- [ ] Use NCAA 2026 template → 64-team bracket created with all teams
- [ ] Share bracket URL with logged-out browser → public view works
- [ ] Vote as logged-out user → vote recorded, duplicate blocked
- [ ] Forgot password → email received → reset works
- [ ] Image upload → served from R2 URL
- [ ] Export PNG → renders correctly

---

## Files to Create / Modify

### New files
- `nixpacks.toml` — Node 20 + python3 build config
- `data/ncaa-2026.json` — NCAA 2026 team list (populated after Selection Sunday)
- `docs/superpowers/specs/2026-03-11-public-launch-design.md` — this file

### Modified files
- `server.js` — R2 upload, rate limiting, password reset, per-bracket payments, 64-team seedings, NCAA template endpoint
- `public/index.html` — landing page section, payment modal, forgot-password UI
- `public/app.js` — payment modal logic, NCAA template button, 64-team round labels
- `public/style.css` — landing page styles, pricing table, payment modal
- `package.json` — add `@aws-sdk/client-s3`, `express-rate-limit`

---

## What's Explicitly Out of Scope

- Email verification on register (adds friction, can add post-launch)
- Analytics (can add Plausible/Umami any time)
- CI/CD pipeline beyond Railway auto-deploy
- Double elimination, group stage, round robin (future roadmap)
- Mobile app
