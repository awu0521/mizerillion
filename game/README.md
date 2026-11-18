# Mizerillion: the game

A private, Krillion-style daily trivia game for one group chat, built on top of
[OpenKrillion](https://github.com/VulcanEon/openkrillion.com-service) (MIT). It runs as a Cloudflare
Worker that serves `public/`, with Supabase (Postgres) for data. The browser only ever talks to the
Worker, and only the Worker holds a Supabase key.

**Setup in order:** [install](#1-install) → [Supabase](#2-supabase-one-time) →
[passwords](#3-passwords) → [seed the bank](#4-seed-the-prompt-bank) → [add members](#5-members) →
[play locally](#6-play-locally) → [deploy](#7-deploy-to-cloudflare).

## Never commit the bank

`../bank_generation/data/prompt_bank.json` is real chat content. It stays git-ignored, reaches Supabase
only through `npm run seed` on your machine, and is never bundled into the Worker or `public/`
(`npm run deploy` checks this before every upload). `.dev.vars` holds your keys and is git-ignored too.

## 1. Install

Needs Node 22 or newer.

```bash
cd game
npm install
npm test
```

## 2. Supabase (one-time)

1. Create a project at [supabase.com](https://supabase.com) (this one uses Canada (Central)). Save
   the database password somewhere safe; the game doesn't need it.
2. Create the tables: open **SQL Editor → New query**, paste each file from `supabase/migrations/`
   and click **Run**, one at a time, in filename order:
   1. `20261118000000_game_schema.sql`
   2. `20261118010000_service_role_grants.sql`
   3. `20261118020000_player_auth.sql`
   4. `20261118030000_admin.sql`
   5. `20261118040000_admin_editing.sql`
   6. `20261118050000_settings.sql`

   `npm run check:db` tells you which ones have been run (and `npm run deploy` won't deploy until they all have).
3. Get the keys: **Project Settings → API Keys**. You need the **Project URL** and the **secret** key
   (`sb_secret_…`) or the legacy **service_role** key. Not the publishable/anon key: the database
   refuses it on purpose.
4. Put them in `game/.dev.vars`:
   ```bash
   cp .dev.vars.example .dev.vars
   ```
   ```
   SUPABASE_URL=https://xxxx.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=sb_secret_...
   ```

Every table has row level security on with no policies, and the `anon` and `authenticated` roles have
no privileges, so the public key can read and write nothing. Only the Worker's key can.

## 3. Passwords

There are two passwords: one **player** password the whole group shares, and a separate **admin**
password. Neither is stored anywhere, only a hash of it. Use at least 12 characters, and two
different passwords.

```bash
node scripts/hash_password.mjs     # type the player password twice (nothing shows); prints a hash
node scripts/hash_password.mjs     # again for the admin password
```

Add both hashes to `game/.dev.vars`, pasted as-is:

```
PLAYER_PASSWORD_HASH=pbkdf2$100000$...
ADMIN_PASSWORD_HASH=pbkdf2$100000$...
```

Changing a hash later logs everyone out of that kind of session.

## 4. Seed the prompt bank

```bash
npm run seed -- --dry-run     # shows what would change, writes nothing
npm run seed                  # writes it
```

It reads `../bank_generation/data/prompt_bank.json` (pass another path to use a different file). Run it
again whenever you regenerate the bank:

- New prompts are added; ones marked `review: true` start switched off.
- If an existing prompt's text or answers changed, it prints a diff and writes nothing until you run
  `npm run seed -- --force`.
- **It never undoes the admin page:** tiers, aliases, added/renamed/deleted answers, edited quips and
  questions, prompts made there, and on/off switches all stay as the admin page left them.
- Answers nobody could type (e.g. Chinese characters, or `⁉`) are reported; give them an alias.

## 5. Members

These are the names players pick after the password. The easiest way to manage them is the admin
page's **Members** tab (add, rename, hide/show). Players whose name is missing can also tap **Name not
here?** in the picker and add it with the admin password. From the command line:

```bash
node scripts/add_member.mjs "Annie"                  # add, or bring back a hidden name
node scripts/add_member.mjs --rename "annie" "Annie" # change how a name shows; keeps their dives
node scripts/add_member.mjs --deactivate "Annie"     # hide from the picker; past dives stay
node scripts/add_member.mjs --list
```

## 6. Play locally

```bash
npm run dev
```

```
Which prompts do you want to play with?
  1) Your real prompt bank (in memory, no database)
  2) Fake test bank (in memory, no database)
  3) Supabase (whatever you last seeded)
Choose 1-3 [1]:
```

Then open http://localhost:8787. Skip the question with `npm run dev:bank`, `dev:fixture` or
`dev:supabase`; stop with Ctrl+C. Options 1 and 2 keep everything in memory (lost on restart) and use
five made-up names instead of your members. All three need `PLAYER_PASSWORD_HASH` in `.dev.vars`.

Local play with option 3 uses the same Supabase project as the live site, so local dives count. For
throwaway testing, use option 1 or 2.

## 7. Deploy to Cloudflare

You need a free [Cloudflare](https://dash.cloudflare.com/sign-up) account.

```bash
cd game
npx wrangler login     # opens the browser once to connect Wrangler to your account
npm run deploy         # checks no game data is in the upload, then deploys
npm run secrets        # copies the 4 secrets from .dev.vars to Cloudflare (asks first)
```

- `npm run deploy` prints the site's address, e.g. `https://mizerillion.<your-subdomain>.workers.dev`.
  Until the secrets are set, the site only says "The game isn’t set up yet."
- `npm run secrets` sends `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `PLAYER_PASSWORD_HASH` and
  `ADMIN_PASSWORD_HASH`. It shows only the names, checks each value looks right, and asks before
  sending. Secrets apply straight away, with no redeploy.
- To use **different production passwords** than your local ones, set them yourself instead:
  ```bash
  node scripts/hash_password.mjs
  npx wrangler secret put PLAYER_PASSWORD_HASH     # paste the hash when asked
  ```
  (and the same with `ADMIN_PASSWORD_HASH`).

Then check the live site: the password screen loads, the player password gets you to the name
picker, a dive plays, and `/admin` signs in with the admin password.

**Later updates:** commit as usual, then `npm run deploy` again. Secrets, Supabase data and sessions
stay as they are. To undo a bad deploy: `npx wrangler rollback`.

**Your own domain (optional):** Cloudflare dashboard → **Workers & Pages → mizerillion → Settings →
Domains & Routes → Add → Custom domain**. The domain needs to be on Cloudflare. Nothing in the code
changes.

**Renaming the game:** the in-game name is `GAME.name` in `public/site.mjs`. The Cloudflare Worker's
name (and so its `workers.dev` address) is `name` in `wrangler.jsonc`.

### If something goes wrong

- **Login says "Wrong password" for the right password:** the secret isn't set, or was set from a
  different hash. Run `npm run secrets -- PLAYER_PASSWORD_HASH` (or `ADMIN_PASSWORD_HASH`).
- **"The game isn’t set up yet":** `SUPABASE_URL` or `SUPABASE_SERVICE_ROLE_KEY` is missing; run
  `npm run secrets`.
- **Login sometimes fails with Cloudflare error 1102 ("exceeded CPU time"):** password hashing is
  deliberately slow (100,000 PBKDF2 rounds), which can go over the free plan's 10 ms CPU limit per
  request. Logins are rare (sessions last 30 days), so it may never happen; if it does, the Workers
  Paid plan ($5/month) removes the limit.
- **Live logs:** `npx wrangler tail` shows errors as they happen. They never include passwords,
  tokens or answers.

## Admin

The admin page is at `/admin`. A small **Admin** link sits in the bottom-right corner of the password
screen and the game's start and results screens. It's only a shortcut: every admin request is checked
on the server. It has three tabs: **Prompts** (the editor and upcoming prompts), **Members** and
**Settings** (launch date, login lockouts, audit log).

- **Members:** add a name, rename one, or hide/show it. Hidden names leave the picker but keep their
  past dives and scores. In the game's name picker, **Name not here?** lets a player add their own name
  with the admin password (same lockouts and audit as signing in to admin), and **← Back to the
  password screen** signs out.

- **Prompt list:** search by id, text or category; shows on/off, needs review, a ⚠ when something
  looks off, and how many answers each tier has.
- **New prompt** (button above the list): type the question and a category. It starts switched off
  and can't be switched on until it has an answer. Its id comes from the question and never changes.
- **Answers:** answer, aliases, weight, quip and a coloured **tier chip**. Click the chip, pick a
  tier, and it saves straight away, with **Undo**. Warnings (no One in a Mizerillion, more than one, no
  Plankton) never block a save.
- **Add an answer** (above the table): type it, pick a tier, Add. **edit** on a row changes its text,
  aliases and quip, or deletes it. **edit** next to the question changes the question or category.
  Answers must be unique within a prompt, aliases included, so a guess never matches two answers.
- **On/off** checkbox per prompt, and the **top wrong guesses** with "add as alias of…".
- **Changes apply to rounds scored from then on**, including later players the same day. Scores
  already given never change.
- **Launch date:** the day of Dive #1. Before it, the game is in **preview**: anyone with the player
  password can play as many dives as they like, with no name picker, no leaderboard and **nothing
  stored** (no dives, scores, guesses or puzzles; preview dives also avoid the launch-day prompts).
  At midnight Vancouver time on the launch date, the real game starts by itself. Changing the date
  after launch renumbers every dive, so the page asks first. If no date is saved, `launchDate` in
  `public/site.mjs` is used.
- **Upcoming prompts:** today's 7 (fixed once anyone has played) and tomorrow's likely 7; before
  launch, the launch day's and the day after's.
- **Audit log:** every admin sign-in attempt, sign-out and edit, with old → new values.

## How access works

- **Without a player session** the site shows only the password screen (game name and art). Every
  `/api/*` game route returns 401; nothing about prompts, answers, scores or names is sent.
- **After the password**, players pick their name; it's remembered on that device until **Not you?
  Switch**. **Log out** is in the ☰ menu. It's trust-based: anyone with the password can pick any
  name, but each member gets one daily dive.
- **Passwords:** PBKDF2-SHA256 (100,000 rounds) via WebCrypto; constant-work checks and the same
  "Wrong password" for anything wrong. 5 failures from one IP in 15 minutes lock that IP for 15
  minutes, doubling each time up to 24 hours; 50 failures an hour from anywhere disable login for an
  hour. Player and admin attempts are counted separately.
- **Sessions:** a random 32-byte token in an HttpOnly cookie; only its SHA-256 hash is stored.
  Players: `__Host-play`, SameSite=Lax, 30 days. Admin: `__Host-admin`, SameSite=Strict, 30 minutes
  idle or 8 hours total. (On plain `http://localhost` the cookies are `play_dev` / `admin_dev`, because
  some browsers refuse `__Host-` cookies over http.) Log out revokes on the server; a new password
  hash ends every session of that kind; player and admin sessions never work as each other.
- **Every change** must come from the site's own Origin with the session's CSRF token. Admin input is
  validated strictly (known fields, real prompts and answers, valid tiers, size limits).
- **Headers on every response:** a strict Content-Security-Policy (no inline scripts,
  `frame-ancestors 'none'`), `nosniff`, `Referrer-Policy: same-origin`, HSTS, and `no-store` on pages
  and API responses.

## Data

| Table | What it holds |
|---|---|
| `members` | `id, display_name, active, created_at` |
| `prompts` | `id, text, category, answers (jsonb), enabled, needs_review, note, version`, plus marks for admin-page changes |
| `puzzles` | one row per day (America/Vancouver): `date, day_number, prompt_ids` |
| `runs` | dives: one daily per member per date, plus practice dives; clock fields in epoch ms |
| `answers` | one scored round each; scores never change after they're written |
| `guess_log` | every guess, including rejected ones, with the prompt it was for |
| `player_login_attempts`, `admin_login_attempts` | `ip, success, created_at` for lockouts |
| `player_sessions`, `admin_sessions` | token hash, password fingerprint, expiry, revoked (players: picked member; admin: `last_seen`) |
| `admin_audit` | every admin sign-in attempt, sign-out and edit |

Views: `daily_leaderboard`, `member_stats` (all-time average, best, total), `member_streaks` (best
and current daily streak) and `rejected_guesses`. Practice dives never count. Scoring goes through
the `score_round` function, so a round is scored once even if two requests race.

The game day resets at midnight America/Vancouver. A day's 7 prompts are picked the first time anyone
opens that day (at most 2 per category, at most 1 `nicknames-`/`words-` prompt, avoiding the last 14
days where possible) and never change.

## Tests

`npm test` runs everything:

- **Your real bank** (`tests/bank.test.mjs`), if `../bank_generation/data/prompt_bank.json` exists:
  it's valid for seeding, every answer and alias matches itself and nothing else, there are enough
  prompts for 60 days, and full dives play through with no answer sent early. The file is read at run
  time, never copied; failures name prompts by id, not text. `TEST_BANK=path npm test` checks another
  file.
- **The fake bank** (`fixtures/sample_bank.json`) for everything else: matching, scoring, the clock,
  puzzles, player and admin passwords, sessions, lockouts, CSRF and the editor.

Database tests run the real migrations on [PGlite](https://pglite.dev) (Postgres in WebAssembly), so
no Supabase project or Docker is needed. `npm run check:bundle` builds the deploy bundle and checks it
for game data without deploying.
