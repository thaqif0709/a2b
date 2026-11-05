// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

// A cache for answers from outside services that is shared by everyone, so many drivers asking about the same place
// cost one upstream request, not one each. Cloudflare's own Cache API does nothing on a *.workers.dev address,
// where A2B runs, so this keeps answers in two places that work anywhere: this Worker instance's memory (free and
// instant, but each instance has its own) and a D1 table every instance shares. Requests for the same key that
// arrive together wait for one fetch. Expired rows are deleted by the nightly job.

const MEMORY = new Map(); // key -> { value: Promise, until: ms }
const MEMORY_MAX = 400;

export function sharedCache(db, { memory = MEMORY, now = () => Date.now() } = {}) {
  const remember = (key, value, until) => {
    if (memory.size >= MEMORY_MAX) {
      for (const [k, v] of memory) if (v.until <= now() || memory.size >= MEMORY_MAX) memory.delete(k);
    }
    memory.set(key, { value, until });
  };

  return {
    // The value under key, or load()'s result, kept for ttl seconds. A failed load isn't kept.
    get(key, ttl, load) {
      const hit = memory.get(key);
      if (hit && hit.until > now()) return hit.value;
      const value = (async () => {
        const row = db && (await db.prepare('SELECT body, expires_at FROM shared_cache WHERE key = ?').bind(key).first().catch(() => null));
        if (row && row.expires_at > now()) {
          remember(key, value, row.expires_at); // keep the rest of its time here too
          return JSON.parse(row.body);
        }
        const fresh = await load();
        const until = now() + ttl * 1000;
        remember(key, value, until);
        await db
          ?.prepare('INSERT INTO shared_cache (key, body, expires_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET body = excluded.body, expires_at = excluded.expires_at')
          .bind(key, JSON.stringify(fresh), until)
          .run()
          .catch((e) => console.warn('shared cache', e.message));
        return fresh;
      })();
      remember(key, value, now() + ttl * 1000);
      value.catch(() => memory.get(key)?.value === value && memory.delete(key));
      return value;
    },
  };
}
