// localStorage that never throws (private windows and blocked storage just forget).
export const prefs = {
  get(key: string, fallback = ''): string {
    try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
  },
  set(key: string, value: string): void {
    try { localStorage.setItem(key, value); } catch { /* storage unavailable */ }
  },
};

// A JSON value from prefs, or null when it's missing or unreadable.
export function readJson(key: string): unknown {
  try { return JSON.parse(prefs.get(key)); } catch { return null; }
}
