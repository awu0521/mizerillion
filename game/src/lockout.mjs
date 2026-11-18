// Brute-force limits, worked out from the login-attempt log (pure functions, times in epoch ms).
//   Per IP:  5 failures within 15 minutes locks that IP for 15 minutes; each further lockout doubles
//            (30 min, 1 h, 2 h, …) up to 24 hours. A successful login from that IP resets its level.
//   Global:  50 failures within an hour, across all IPs, disables login for an hour.
// Attempts rejected because of a lockout aren't checked or logged, so they can't extend it.

export const LIMITS = {
  perIp: 5, ipWindow: 15 * 60e3, baseLock: 15 * 60e3, maxLock: 24 * 3600e3, ipHistory: 7 * 24 * 3600e3,
  global: 50, globalWindow: 3600e3,
};

/** attempts: [{ at, success }] for one IP, oldest first. Returns the time the IP is locked until (0 = not). */
export function ipLockedUntil(attempts, limits = LIMITS) {
  let level = 0, until = 0, recent = [];
  for (const { at, success } of attempts) {
    if (success) { level = 0; recent = []; continue; }
    if (at < until) continue;
    recent = recent.filter(t => t > at - limits.ipWindow);
    recent.push(at);
    if (recent.length >= limits.perIp) {
      until = at + Math.min(limits.baseLock * 2 ** level, limits.maxLock);
      level++; recent = [];
    }
  }
  return until;
}

/** failures: failure times across all IPs, oldest first. Returns the time login is disabled until (0 = not). */
export function globalLockedUntil(failures, limits = LIMITS) {
  let until = 0, start = 0;
  for (let i = 0; i < failures.length; i++) {
    while (failures[start] <= failures[i] - limits.globalWindow) start++;
    if (i - start + 1 >= limits.global) until = Math.max(until, failures[i] + limits.globalWindow);
  }
  return until;
}

/** Looks up the attempt log and returns when login is locked until for this IP (0 = not locked). */
export async function lockedUntil(store, kind, ip, t, limits = LIMITS) {
  const [ipRows, failures] = await Promise.all([
    store.loginAttempts(kind, ip, new Date(t - limits.ipHistory).toISOString()),
    store.recentFailures(kind, new Date(t - 2 * limits.globalWindow).toISOString()),
  ]);
  return Math.max(
    ipLockedUntil(ipRows.map(r => ({ at: Date.parse(r.created_at), success: r.success })), limits),
    globalLockedUntil(failures.map(r => Date.parse(r.created_at)), limits),
  );
}
