// Vary-aware HTTP cache core. Framework-free so it can be unit-tested and
// shared with the client (types only) without pulling in express.

/** A single received header line: [name, value], order preserved. */
export type HeaderPair = [string, string];

/** Vary spec learned from an origin response: sorted header names, or '*'. */
export type VarySpec = string[] | '*';

/**
 * One canonical cache-key component for a selecting header.
 * - absent: header not present on the request
 * - list:   mergeable list header, tokens normalized (trim/lowercase/dedupe/sort)
 * - raw:    non-mergeable header, value sequence preserved as received
 */
export type KeyComponent = {
  header: string;
  kind: 'absent' | 'list' | 'raw';
  values: string[];
};

export type CacheKeyView = {
  url: string;
  vary: VarySpec;
  components: KeyComponent[];
};

export type OriginResponse = {
  revision: number;
  body: string;
  vary: VarySpec;
};

export type ReplayOutcome = 'hit' | 'miss' | 'coalesced' | 'bypass';
export type ReplayReason =
  | 'key-matched'
  | 'no-entry'
  | 'stale-revision'
  | 'vary-star'
  | 'inflight-join';

export type ReplayResult = {
  outcome: ReplayOutcome;
  reason: ReplayReason;
  key: CacheKeyView;
  response: OriginResponse;
};

export type CacheEntryView = {
  key: CacheKeyView;
  revision: number;
  body: string;
  stale: boolean;
  storedAt: string;
};

export type CacheStats = {
  originFetches: number;
  hits: number;
  misses: number;
  coalesced: number;
  bypasses: number;
  entries: number;
};

/**
 * List-valued headers whose field lines may be merged and whose tokens are
 * case-insensitive, so they are normalized semantically (split on commas,
 * trim, lowercase, drop empties, dedupe, sort). Anything not in this set is
 * treated as non-mergeable: the exact value sequence is significant.
 */
const LIST_HEADERS = new Set([
  'accept',
  'accept-charset',
  'accept-encoding',
  'accept-language',
  'cache-control',
  'connection',
  'pragma',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/** Parse Vary header line(s) into a canonical spec: sorted unique names, or '*'. */
export function parseVary(values: string[]): VarySpec {
  const tokens = values
    .flatMap((value) => value.split(','))
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length > 0);
  if (tokens.includes('*')) return '*';
  return [...new Set(tokens)].sort();
}

/**
 * Build canonical key components for the selecting headers in `vary`.
 * Header names match case-insensitively; repeated lines are grouped.
 */
export function buildKeyComponents(vary: string[], pairs: HeaderPair[]): KeyComponent[] {
  const byName = new Map<string, string[]>();
  for (const [rawName, value] of pairs) {
    const name = rawName.trim().toLowerCase();
    if (name.length === 0) continue;
    const list = byName.get(name);
    if (list) list.push(value);
    else byName.set(name, [value]);
  }
  return vary.map((header) => {
    const values = byName.get(header);
    if (!values || values.length === 0) return {header, kind: 'absent' as const, values: []};
    if (LIST_HEADERS.has(header)) {
      const tokens = values
        .flatMap((value) => value.split(','))
        .map((token) => token.trim().toLowerCase())
        .filter((token) => token.length > 0);
      return {header, kind: 'list' as const, values: [...new Set(tokens)].sort()};
    }
    return {header, kind: 'raw' as const, values: values.map((value) => value.trim())};
  });
}

function keyString(url: string, components: KeyComponent[]): string {
  return JSON.stringify([url, components]);
}

/** Hash of the raw request headers, used to coalesce fills before Vary is known. */
function rawHash(pairs: HeaderPair[]): string {
  const byName = new Map<string, string[]>();
  for (const [rawName, value] of pairs) {
    const name = rawName.trim().toLowerCase();
    const list = byName.get(name);
    if (list) list.push(value);
    else byName.set(name, [value]);
  }
  return JSON.stringify([...byName.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
}

type Entry = {
  key: string;
  url: string;
  vary: string[];
  components: KeyComponent[];
  revision: number;
  body: string;
  storedAt: string;
};

/**
 * Cache keyed by URL + canonical Vary components.
 *
 * - Vary is learned from origin responses; `Vary: *` responses are never
 *   stored or reused.
 * - Entries become stale automatically when `currentRevision(url)` moves
 *   past the entry's revision; stale entries are never served.
 * - Fills are single-flight per (key, revision generation): concurrent
 *   equivalent requests share one origin fetch, and a fill started before a
 *   revision bump can neither be joined nor overwrite a newer entry.
 */
export class VaryCache {
  private entries = new Map<string, Entry>();
  private inflight = new Map<string, Promise<OriginResponse>>();
  private varyByUrl = new Map<string, VarySpec>();
  private epoch = 0;
  private readonly counters = {originFetches: 0, hits: 0, misses: 0, coalesced: 0, bypasses: 0};

  constructor(private readonly currentRevision: (url: string) => number) {}

  async replay(
    url: string,
    pairs: HeaderPair[],
    origin: (pairs: HeaderPair[]) => Promise<OriginResponse>,
  ): Promise<ReplayResult> {
    const epoch = this.epoch;
    const vary = this.varyByUrl.get(url);
    if (vary === '*') {
      const response = await this.fetchOrigin(origin, pairs);
      this.counters.bypasses += 1;
      return {outcome: 'bypass', reason: 'vary-star', key: {url, vary: '*', components: []}, response};
    }

    const generation = this.currentRevision(url);

    if (vary === undefined) {
      // Vary not learned yet: coalesce only byte-identical header sets so
      // non-equivalent requests can never share a variant.
      const tag = ['learn', url, generation, rawHash(pairs)].join('\n');
      const flying = this.inflight.get(tag);
      if (flying) {
        this.counters.coalesced += 1;
        const response = await flying;
        return {
          outcome: 'coalesced',
          reason: 'inflight-join',
          key: this.keyView(url, this.varyByUrl.get(url) ?? response.vary, pairs),
          response,
        };
      }
      const promise = this.fetchOrigin(origin, pairs);
      this.inflight.set(tag, promise);
      try {
        const response = await promise;
        this.learn(url, response.vary);
        if (response.vary === '*') {
          this.counters.bypasses += 1;
          return {outcome: 'bypass', reason: 'vary-star', key: {url, vary: '*', components: []}, response};
        }
        this.store(url, response.vary, pairs, response, epoch);
        this.counters.misses += 1;
        return {outcome: 'miss', reason: 'no-entry', key: this.keyView(url, response.vary, pairs), response};
      } finally {
        this.inflight.delete(tag);
      }
    }

    const components = buildKeyComponents(vary, pairs);
    const key = keyString(url, components);
    const view: CacheKeyView = {url, vary, components};

    const entry = this.entries.get(key);
    if (entry && entry.revision === generation) {
      this.counters.hits += 1;
      return {outcome: 'hit', reason: 'key-matched', key: view, response: {revision: entry.revision, body: entry.body, vary}};
    }

    // Single-flight per (key, generation): a fill started before a revision
    // bump lives under the old generation and is never joined afterwards.
    const tag = ['fill', key, generation].join('\n');
    const flying = this.inflight.get(tag);
    if (flying) {
      this.counters.coalesced += 1;
      const response = await flying;
      return {outcome: 'coalesced', reason: 'inflight-join', key: view, response};
    }

    const reason: ReplayReason = entry ? 'stale-revision' : 'no-entry';
    const promise = this.fetchOrigin(origin, pairs);
    this.inflight.set(tag, promise);
    try {
      const response = await promise;
      this.learn(url, response.vary);
      if (response.vary === '*') {
        this.counters.bypasses += 1;
        return {outcome: 'bypass', reason: 'vary-star', key: {url, vary: '*', components: []}, response};
      }
      this.store(url, response.vary, pairs, response, epoch);
      this.counters.misses += 1;
      return {outcome: 'miss', reason, key: this.keyView(url, response.vary, pairs), response};
    } finally {
      this.inflight.delete(tag);
    }
  }

  entriesView(): CacheEntryView[] {
    return [...this.entries.values()].map((entry) => ({
      key: {url: entry.url, vary: entry.vary, components: entry.components},
      revision: entry.revision,
      body: entry.body,
      stale: entry.revision !== this.currentRevision(entry.url),
      storedAt: entry.storedAt,
    }));
  }

  stats(): CacheStats {
    return {...this.counters, entries: this.entries.size};
  }

  reset(): void {
    this.entries.clear();
    this.inflight.clear();
    this.varyByUrl.clear();
    this.epoch += 1; // fills already in flight must not store into the fresh cache
    this.counters.originFetches = 0;
    this.counters.hits = 0;
    this.counters.misses = 0;
    this.counters.coalesced = 0;
    this.counters.bypasses = 0;
  }

  private async fetchOrigin(
    origin: (pairs: HeaderPair[]) => Promise<OriginResponse>,
    pairs: HeaderPair[],
  ): Promise<OriginResponse> {
    this.counters.originFetches += 1;
    return origin(pairs);
  }

  private learn(url: string, vary: VarySpec): void {
    this.varyByUrl.set(url, vary);
  }

  private keyView(url: string, vary: VarySpec, pairs: HeaderPair[]): CacheKeyView {
    if (vary === '*') return {url, vary, components: []};
    return {url, vary, components: buildKeyComponents(vary, pairs)};
  }

  private store(url: string, vary: string[], pairs: HeaderPair[], response: OriginResponse, epoch: number): void {
    if (epoch !== this.epoch) return; // cache was reset while the fill was in flight
    if (response.revision < this.currentRevision(url)) return; // already stale
    const components = buildKeyComponents(vary, pairs);
    const key = keyString(url, components);
    const existing = this.entries.get(key);
    if (existing && existing.revision > response.revision) return; // never overwrite a newer revision
    this.entries.set(key, {
      key,
      url,
      vary,
      components,
      revision: response.revision,
      body: response.body,
      storedAt: new Date().toISOString(),
    });
  }
}
