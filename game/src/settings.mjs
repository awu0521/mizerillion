// Settings stored in the database, cached briefly per Worker isolate.
// launch_date: Dive #1. Before it, the game runs in preview mode (nothing is stored).
import { GAME } from '../public/site.mjs';

const CACHE_MS = 30e3;
export const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const validDate = d => typeof d === 'string' && DATE.test(d) && new Date(d + 'T12:00:00Z').toISOString().slice(0, 10) === d && d >= '2024-01-01' && d <= '2100-12-31';

export function createSettings(store, now = () => Date.now()) {
  let cached = null;
  return {
    /** The launch date: the saved setting, or site.mjs's GAME.launchDate if none is saved. */
    async launchDate() {
      if (!cached || now() - cached.at > CACHE_MS) {
        const saved = await store.getSetting('launch_date');
        cached = { value: validDate(saved) ? saved : GAME.launchDate, at: now() };
      }
      return cached.value;
    },
    async setLaunchDate(date) {
      await store.setSetting('launch_date', date, new Date(now()).toISOString());
      cached = { value: date, at: now() };
    },
  };
}
