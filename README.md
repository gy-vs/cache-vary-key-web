# HTTP Cache Lab

Local workbench for cache simulations.

Run `npm install`, then `npm run dev`.

## Vary-aware cache replay

The server (`src/server/cache.ts`) builds canonical cache keys from each
response's `Vary` field:

- Header names match case-insensitively; repeated lines are grouped.
- Mergeable list headers (`Accept-Encoding`, `Accept-Language`, …) are
  normalized semantically: split on commas, trim, lowercase, drop empties,
  dedupe, sort.
- Non-mergeable headers keep their exact value sequence (order and
  duplicates are significant).
- A missing header and a present-but-empty header are distinct keys.
- `Vary: *` responses are never stored or reused.
- Entries go stale automatically when the resource revision moves on;
  concurrent equivalent fills are single-flight, and a stale fill in flight
  never overwrites a newer revision.

API:

- `POST /api/cache/replay` — `{id, headers: {name: value | [values]}, delayMs?}`
  replays a request through the cache and returns the outcome (`hit` /
  `miss` / `coalesced` / `bypass`), the hit reason, the structured key
  components, and the response variant.
- `GET /api/cache/entries` — stored entries with their canonical keys,
  revision, staleness, and cache stats.
- `DELETE /api/cache` — reset the cache.

The frontend only renders the structured key components and hit reasons
returned by the server; it never recomputes cache keys itself.

Run `npm test` for the cache-key and concurrency test suites.
