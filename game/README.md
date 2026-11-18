# Mizerillion: the game

A private, Krillion-style daily trivia game for one group chat, built on top of
[OpenKrillion](https://github.com/VulcanEon/openkrillion.com-service) (MIT). It runs as a Cloudflare
Worker that serves `public/`, with Supabase (Postgres) for data. The browser only ever talks to the
Worker, and only the Worker holds a Supabase key.

> This README covers local play, Supabase and player access. Admin and deploying to Cloudflare are
> added in later milestones.

## Never commit the bank

`../bank_generation/data/prompt_bank.json` is real chat content. It stays git-ignored, goes to
Supabase only through `scripts/seed_prompts.mjs` run on your machine, and is never bundled into the
Worker or `public/`. Tests use only the fake bank in `fixtures/sample_bank.json`.

## 1. Install

```bash
cd game
npm install
npm test
```

## 2. Supabase (one-time)

1. Create a project at [supabase.com](https://supabase.com) (this one uses Canada (Central)).
   Save the database password somewhere safe; the game doesn't need it.
2. Create the tables: in the dashboard open **SQL Editor → New query**, paste the whole of
   `supabase/migrations/20261118000000_game_schema.sql`, and click **Run**. Run each later migration
   file the same way, in filename order.
3. Get the keys: **Project Settings → API Keys**. You need the **Project URL** and the
   **service_role** key (or a **secret** key, `sb_secret_…`). Don't use the anon/publishable key; the
   schema blocks it on purpose.
4. Put them in `game/.dev.vars` (git-ignored):
   ```bash
   cp .dev.vars.example .dev.vars
   # then edit .dev.vars
   ```

Every table has row level security on with no policies, and the `anon` and `authenticated` roles have
no privileges, so the public key can't read or write anything. Only the service-role key, held by the
Worker, can.

## 3. Seed the prompt bank

```bash
npm run seed -- --dry-run     # show what would change, write nothing
npm run seed                  # write it
```

`npm run seed` reads `../bank_generation/data/prompt_bank.json` by default; pass another path to use a
different file. Run it again after regenerating the bank:

- **Tier and alias edits made in Supabase are kept.** Answers are matched by their normalized text.
- If an existing prompt's text or answers changed (added, removed, new weight, quip or aliases), the
  script prints a diff and writes nothing. Re-run with `--force` to apply. Forcing still keeps
  Supabase tiers and aliases, but answers removed from the bank are removed.
- `enabled` is never changed for prompts already in Supabase. New prompts with `review: true` start
  disabled. To turn one on before the admin page exists: **Table Editor → prompts**, set `enabled` to
  `true`.
- Answers that normalize to nothing (for example text in Chinese characters, or `⁉`) can't be typed
  to match. The script warns about them; add an alias in the bank or in Supabase.

## 4. Player password and names

Everyone shares one player password. Only its hash is stored, as `PLAYER_PASSWORD_HASH`.

```bash
node scripts/hash_password.mjs     # type the password twice (nothing shows); prints the hash
```

Add the printed hash to `game/.dev.vars` as `PLAYER_PASSWORD_HASH=pbkdf2$100000$…` (paste it as-is).
In production it goes in with `npx wrangler secret put PLAYER_PASSWORD_HASH` (milestone 5).
Passwords need at least 12 characters. **Changing the hash logs every player out.**

Add the names players pick from (Supabase):

```bash
node scripts/add_member.mjs "Avery"                 # add, or bring back a hidden name
node scripts/add_member.mjs --deactivate "Avery"    # hide from the picker; past dives stay
node scripts/add_member.mjs --rename "avery" "Avery"   # change how a name shows; keeps their dives
node scripts/add_member.mjs --list
```

How access works:

- Without a session, the site shows only the password screen (game name and art). Every `/api/*` game
  route returns 401, and nothing about prompts, answers, scores or names is sent.
- After the password, players pick their name. It's remembered on that device until they tap
  **Not you? Switch**. **Log out** is in the ☰ menu. This is trust-based: anyone with the password can
  pick any name, but each member still gets one daily dive.
- Sessions last 30 days. The cookie is `__Host-play` (HttpOnly, Secure, SameSite=Lax); on plain
  `http://localhost` it's `play_dev`, because some browsers refuse `__Host-` cookies over http.
  Only a SHA-256 hash of the session token is stored, in `player_sessions`.
- Wrong, empty or malformed passwords all get the same "Wrong password". 5 failures from one IP in
  15 minutes lock that IP for 15 minutes, doubling each time up to 24 hours. 50 failures in an hour
  from anywhere disable login for an hour. Attempts are logged in `player_login_attempts`.
- Every request that changes data must come from the site's own Origin and carry the session's
  CSRF token.
- The in-memory modes (`dev:bank`, `dev:fixture`) use five made-up names from
  `fixtures/sample_members.json` instead of Supabase.

## 5. Play locally

```bash
npm run dev           # asks which prompts to use, then serves http://localhost:8787
```

It asks:

```
Which prompts do you want to play with?
  1) Your real prompt bank (in memory, no database)
  2) Fake test bank (in memory, no database)
  3) Supabase (whatever you last seeded)
Choose 1-3 [1]:
```

Press Enter for your real bank. To skip the question, use `npm run dev:bank`, `npm run dev:fixture`
or `npm run dev:supabase`. Stop the server with Ctrl+C.

`dev:bank` and `dev:fixture` keep everything in memory, so dives are lost when the server restarts.
The normal `wrangler.jsonc` (used for deploying) bundles no prompt bank at all.

The game day resets at midnight America/Vancouver. The day's 7 prompts are picked the first time
anyone opens the day, stored in `puzzles`, and never change.

Earlier test builds created anonymous "Diver XXXX" members. Remove them and their dives with
**SQL Editor**:

```sql
delete from public.members where display_name like 'Diver %' and not active;
```

## Data

| Table | What it holds |
|---|---|
| `members` | `id, display_name, active, created_at` |
| `prompts` | the bank: `id, text, category, answers (jsonb), enabled, needs_review, note, updated_at` |
| `puzzles` | one row per day: `date, day_number, prompt_ids` |
| `runs` | dives: one daily per member per date, plus practice dives; clock fields in epoch ms |
| `answers` | one scored round each; scores never change after they're written |
| `guess_log` | every guess, including rejected ones, with the prompt it was for |
| `player_login_attempts` | `ip, success, created_at` for every password attempt (lockouts) |
| `player_sessions` | token hash, picked member, password fingerprint, expiry, revoked |

Views: `daily_leaderboard` (score, tiers and rank per completed daily dive), `member_stats`
(all-time dives, average, best, total) and `member_streaks` (best and current daily streak).
Practice dives never count towards any of them. Scoring goes through the `score_round` function,
so a round can only be scored once even if two requests race.

## Tests

`npm test` runs everything:

- **Your real bank** (`tests/bank.test.mjs`), if `../bank_generation/data/prompt_bank.json` exists:
  it's valid for seeding, every answer and alias matches itself and nothing else, there are enough
  prompts for 60 days within the selection rules, and a full daily and practice dive play through
  with no answer sent early. The file is read at run time and never copied into the repo; failures
  name prompts by id and answers by position, not text. Skipped where the file doesn't exist. Use
  `TEST_BANK=path/to/bank.json npm test` to check another file.
- **The fake bank** (`fixtures/sample_bank.json`) for everything else, because those tests check exact
  made-up answers (like `seal` matching 🦭).

Database tests use [PGlite](https://pglite.dev) (Postgres in
WebAssembly) with the real migrations, so no Supabase project or Docker is needed.
