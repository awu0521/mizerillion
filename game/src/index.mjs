// Worker entry point. "prompt-bank" is a build-time alias set in wrangler.jsonc:
//   wrangler.jsonc          -> ../bank_generation/data/prompt_bank.json (the real, git-ignored bank)
//   wrangler.fixture.jsonc  -> fixtures/sample_bank.json (fake bank, for working without the real data)
// The bank is bundled into the server-side Worker only; it is never in public/ and never sent
// to the browser except answer-by-answer as the game allows. Milestone 2 replaces this with Supabase.
import BANK from 'prompt-bank';
import { createApp } from './worker.mjs';
import { MemoryStore } from './store/memory.mjs';

let app = null;
export default {
  fetch(request, env, ctx) {
    app ??= createApp({ store: new MemoryStore({ bank: BANK }) });
    return app.fetch(request, env, ctx);
  },
};
