// Worker entry point: picks the data store, then hands requests to the game app.
//   wrangler.jsonc          -> Supabase (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from .dev.vars / secrets)
//   wrangler.bank.jsonc     -> in-memory store with YOUR real bank, local only (npm run dev:bank)
//   wrangler.fixture.jsonc  -> in-memory store with the FAKE fixture bank (npm run dev:fixture)
// "prompt-bank" is a build-time alias each config sets. wrangler.jsonc points it at an empty bank, so
// the deployed Worker contains no bank at all; the real bank reaches Supabase via scripts/seed_prompts.mjs.
import BANK from 'prompt-bank';
import FAKE_MEMBERS from 'fake-members'; // made-up names for the in-memory modes; empty in production
import { createApp } from './worker.mjs';
import { MemoryStore } from './store/memory.mjs';
import { SupabaseStore, supabaseClient } from './store/supabase.mjs';

let app = null;
function build(env) {
  if (env.STORE === 'memory') return createApp({ store: new MemoryStore({ bank: BANK, members: FAKE_MEMBERS }) });
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return null;
  return createApp({ store: new SupabaseStore(supabaseClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)) });
}
export default {
  fetch(request, env, ctx) {
    app ??= build(env);
    if (!app) {
      // Locally, say what's missing; in production, say nothing about the setup.
      const message = env.LOCAL_DEVELOPMENT === 'true' ? 'Supabase is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in game/.dev.vars (see game/README.md), or run: npm run dev:bank' : 'The game isn’t set up yet.';
      if (env.LOCAL_DEVELOPMENT !== 'true') console.error('SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY secret is missing.');
      return new Response(message, { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
    }
    return app.fetch(request, env, ctx);
  },
};
