import {describe, expect, it} from 'vitest';
import {
  VaryCache,
  buildKeyComponents,
  parseVary,
  type HeaderPair,
  type OriginResponse,
  type VarySpec,
} from '../src/server/cache';

const URL = '/api/experiments/x';

function pairs(headers: Record<string, string | string[]>): HeaderPair[] {
  const out: HeaderPair[] = [];
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) for (const item of value) out.push([name, item]);
    else out.push([name, value]);
  }
  return out;
}

/** Origin whose body echoes the raw request pairs, so content crossing is visible. */
function fakeOrigin(state: {revision: number}, vary: VarySpec, latencyMs = 0) {
  let calls = 0;
  const origin = async (p: HeaderPair[]): Promise<OriginResponse> => {
    calls += 1;
    const revision = state.revision; // snapshot at fetch start, like a real origin read
    if (latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, latencyMs));
    return {revision, body: `rev=${revision} ${JSON.stringify(p)}`, vary};
  };
  return {origin, calls: () => calls};
}

describe('parseVary', () => {
  it('normalizes case, order and duplicates', () => {
    expect(parseVary(['Accept-Encoding, ACCEPT-LANGUAGE'])).toEqual(['accept-encoding', 'accept-language']);
    expect(parseVary(['accept-language', 'Accept-Encoding'])).toEqual(['accept-encoding', 'accept-language']);
    expect(parseVary(['accept-encoding', 'Accept-Encoding'])).toEqual(['accept-encoding']);
  });
  it('treats * as never-reusable', () => {
    expect(parseVary(['*'])).toBe('*');
    expect(parseVary(['accept-encoding, *'])).toBe('*');
  });
});

describe('buildKeyComponents', () => {
  it('groups repeated lines case-insensitively and normalizes list headers', () => {
    const components = buildKeyComponents(
      ['accept-encoding'],
      pairs({'Accept-Encoding': 'GZip, br', 'ACCEPT-ENCODING': ['gzip', '']}),
    );
    expect(components).toEqual([{header: 'accept-encoding', kind: 'list', values: ['br', 'gzip']}]);
  });
  it('keeps the value sequence for non-mergeable headers', () => {
    const components = buildKeyComponents(['x-flag'], pairs({'X-Flag': [' b ', 'a']}));
    expect(components).toEqual([{header: 'x-flag', kind: 'raw', values: ['b', 'a']}]);
  });
  it('distinguishes absent from empty', () => {
    expect(buildKeyComponents(['accept-encoding'], pairs({}))).toEqual([
      {header: 'accept-encoding', kind: 'absent', values: []},
    ]);
    expect(buildKeyComponents(['accept-encoding'], pairs({'accept-encoding': ''}))).toEqual([
      {header: 'accept-encoding', kind: 'list', values: []},
    ]);
  });
});

describe('VaryCache key equivalence', () => {
  it('shares one entry across case, order, duplicate and repeated-line differences', async () => {
    const state = {revision: 1};
    const cache = new VaryCache(() => state.revision);
    const {origin, calls} = fakeOrigin(state, ['accept-encoding']);

    const first = await cache.replay(URL, pairs({'Accept-Encoding': 'gzip, br'}), origin);
    expect(first.outcome).toBe('miss');

    const equivalents: Record<string, string | string[]>[] = [
      {'accept-encoding': 'br,gzip'},
      {'ACCEPT-ENCODING': 'GZip,, BR'},
      {'Accept-Encoding': ['gzip', 'br']}, // two header lines
      {'accept-encoding': 'gzip, gzip, br'},
    ];
    for (const headers of equivalents) {
      const result = await cache.replay(URL, pairs(headers), origin);
      expect(result.outcome).toBe('hit');
      expect(result.response.body).toBe(first.response.body);
    }
    expect(calls()).toBe(1);
    expect(cache.entriesView()).toHaveLength(1);
  });

  it('does not cross content between non-equivalent requests', async () => {
    const state = {revision: 1};
    const cache = new VaryCache(() => state.revision);
    const {origin} = fakeOrigin(state, ['accept-encoding']);

    const gzip = await cache.replay(URL, pairs({'accept-encoding': 'gzip'}), origin);
    const br = await cache.replay(URL, pairs({'accept-encoding': 'br'}), origin);
    expect(br.outcome).toBe('miss');
    expect(br.response.body).not.toBe(gzip.response.body);
    expect(br.response.body).toContain('br');
    expect(cache.entriesView()).toHaveLength(2);
  });

  it('distinguishes missing headers from empty values, and reuses both', async () => {
    const state = {revision: 1};
    const cache = new VaryCache(() => state.revision);
    const {origin} = fakeOrigin(state, ['accept-encoding']);

    const absent1 = await cache.replay(URL, pairs({}), origin);
    expect(absent1.key.components[0]).toEqual({header: 'accept-encoding', kind: 'absent', values: []});
    const absent2 = await cache.replay(URL, pairs({}), origin);
    expect(absent2.outcome).toBe('hit');

    const empty1 = await cache.replay(URL, pairs({'accept-encoding': ''}), origin);
    expect(empty1.outcome).toBe('miss');
    expect(empty1.key.components[0]).toEqual({header: 'accept-encoding', kind: 'list', values: []});
    expect(empty1.response.body).not.toBe(absent1.response.body);
    const empty2 = await cache.replay(URL, pairs({'accept-encoding': '  '}), origin);
    expect(empty2.outcome).toBe('hit');
    expect(cache.entriesView()).toHaveLength(2);
  });

  it('preserves value sequence for non-mergeable headers', async () => {
    const state = {revision: 1};
    const cache = new VaryCache(() => state.revision);
    const {origin} = fakeOrigin(state, ['x-lab-flag']);

    await cache.replay(URL, pairs({'x-lab-flag': ['a', 'b']}), origin);
    expect((await cache.replay(URL, pairs({'x-lab-flag': ['a', 'b']}), origin)).outcome).toBe('hit');
    // order matters
    expect((await cache.replay(URL, pairs({'x-lab-flag': ['b', 'a']}), origin)).outcome).toBe('miss');
    // one combined line is not the same sequence as two lines
    expect((await cache.replay(URL, pairs({'x-lab-flag': 'a, b'}), origin)).outcome).toBe('miss');
    // duplicates are significant
    expect((await cache.replay(URL, pairs({'x-lab-flag': ['a', 'a']}), origin)).outcome).toBe('miss');
    expect((await cache.replay(URL, pairs({'x-lab-flag': 'a'}), origin)).outcome).toBe('miss');
    expect(cache.entriesView()).toHaveLength(5);
  });

  it('keys on every field of a multi-field Vary', async () => {
    const state = {revision: 1};
    const cache = new VaryCache(() => state.revision);
    const {origin} = fakeOrigin(state, ['accept-encoding', 'accept-language']);

    const base = await cache.replay(URL, pairs({'accept-encoding': 'gzip', 'accept-language': 'en'}), origin);
    expect(base.outcome).toBe('miss');
    // same encoding, different language -> different entry
    const otherLang = await cache.replay(URL, pairs({'accept-encoding': 'gzip', 'accept-language': 'fr'}), origin);
    expect(otherLang.outcome).toBe('miss');
    expect(otherLang.response.body).not.toBe(base.response.body);
    // equivalent to the first request -> hit
    const again = await cache.replay(URL, pairs({'Accept-Encoding': 'GZip', 'ACCEPT-LANGUAGE': 'EN'}), origin);
    expect(again.outcome).toBe('hit');
    expect(again.response.body).toBe(base.response.body);
    expect(cache.entriesView()).toHaveLength(2);
  });

  it('never stores or reuses Vary:* responses', async () => {
    const state = {revision: 1};
    const cache = new VaryCache(() => state.revision);
    const {origin, calls} = fakeOrigin(state, '*');

    for (let i = 0; i < 3; i += 1) {
      const result = await cache.replay(URL, pairs({'accept-encoding': 'gzip'}), origin);
      expect(result.outcome).toBe('bypass');
      expect(result.reason).toBe('vary-star');
      expect(result.key.vary).toBe('*');
    }
    expect(calls()).toBe(3);
    expect(cache.entriesView()).toHaveLength(0);
  });
});

describe('VaryCache revisions', () => {
  it('refills stale entries after a revision bump and serves the new revision', async () => {
    const state = {revision: 1};
    const cache = new VaryCache(() => state.revision);
    const {origin} = fakeOrigin(state, ['accept-encoding']);

    await cache.replay(URL, pairs({'accept-encoding': 'gzip'}), origin);
    await cache.replay(URL, pairs({'accept-encoding': 'br'}), origin);
    expect((await cache.replay(URL, pairs({'accept-encoding': 'gzip'}), origin)).outcome).toBe('hit');

    state.revision = 2;
    expect(cache.entriesView().every((entry) => entry.stale)).toBe(true);

    const refilled = await cache.replay(URL, pairs({'accept-encoding': 'gzip'}), origin);
    expect(refilled.outcome).toBe('miss');
    expect(refilled.reason).toBe('stale-revision');
    expect(refilled.response.revision).toBe(2);
    expect((await cache.replay(URL, pairs({'accept-encoding': 'gzip'}), origin)).outcome).toBe('hit');

    const entries = cache.entriesView();
    const gzipEntry = entries.find((entry) => entry.key.components[0].values.join() === 'gzip');
    const brEntry = entries.find((entry) => entry.key.components[0].values.join() === 'br');
    expect(gzipEntry).toMatchObject({revision: 2, stale: false});
    expect(brEntry).toMatchObject({revision: 1, stale: true}); // untouched key stays stale, never served
  });

  it('a stale fill in flight never overwrites a newer revision', async () => {
    const state = {revision: 1};
    const cache = new VaryCache(() => state.revision);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const origin = async (): Promise<OriginResponse> => {
      calls += 1;
      const revision = state.revision;
      if (calls === 1) await gate; // first fill is slow
      return {revision, body: `body-rev-${revision}`, vary: ['accept-encoding']};
    };

    const slow = cache.replay(URL, pairs({'accept-encoding': 'gzip'}), origin);
    await Promise.resolve(); // let the slow fill reach the gate with revision 1 snapshotted
    state.revision = 2;

    const fast = await cache.replay(URL, pairs({'accept-encoding': 'gzip'}), origin);
    expect(fast.response.body).toBe('body-rev-2');

    release();
    const stale = await slow;
    expect(stale.response.body).toBe('body-rev-1'); // the caller still gets its own old response

    const after = await cache.replay(URL, pairs({'accept-encoding': 'gzip'}), origin);
    expect(after.outcome).toBe('hit');
    expect(after.response.body).toBe('body-rev-2');
    expect(cache.entriesView()).toHaveLength(1);
    expect(cache.entriesView()[0]).toMatchObject({revision: 2, stale: false});
  });
});

describe('VaryCache concurrency', () => {
  it('coalesces concurrent equivalent fills into one origin fetch', async () => {
    const state = {revision: 1};
    const cache = new VaryCache(() => state.revision);
    const {origin, calls} = fakeOrigin(state, ['accept-encoding'], 15);

    await cache.replay(URL, pairs({'accept-encoding': 'identity'}), origin); // learn Vary
    state.revision = 2; // make the stored entry stale so the wave below fills
    const before = calls();

    const wave = await Promise.all([
      cache.replay(URL, pairs({'Accept-Encoding': 'gzip, br'}), origin),
      cache.replay(URL, pairs({'accept-encoding': 'br,gzip'}), origin),
      cache.replay(URL, pairs({'ACCEPT-ENCODING': ['GZip', 'br']}), origin),
      cache.replay(URL, pairs({'accept-encoding': 'gzip,, gzip, br'}), origin),
    ]);
    expect(wave.filter((r) => r.outcome === 'miss')).toHaveLength(1);
    expect(wave.filter((r) => r.outcome === 'coalesced')).toHaveLength(3);
    expect(calls() - before).toBe(1);
    expect(new Set(wave.map((r) => r.response.body)).size).toBe(1);
    expect(cache.entriesView().filter((e) => !e.stale)).toHaveLength(1);
  });

  it('does not coalesce non-equivalent requests, even while Vary is unknown', async () => {
    const state = {revision: 1};
    const cache = new VaryCache(() => state.revision);
    const {origin, calls} = fakeOrigin(state, ['accept-encoding'], 15);

    const [gzip, br] = await Promise.all([
      cache.replay(URL, pairs({'accept-encoding': 'gzip'}), origin),
      cache.replay(URL, pairs({'accept-encoding': 'br'}), origin),
    ]);
    expect(gzip.response.body).toContain('gzip');
    expect(br.response.body).toContain('br');
    expect(calls()).toBe(2);
    expect(cache.entriesView()).toHaveLength(2);
  });

  it('coalesces byte-identical requests before Vary is learned', async () => {
    const state = {revision: 1};
    const cache = new VaryCache(() => state.revision);
    const {origin, calls} = fakeOrigin(state, ['accept-encoding'], 15);

    const wave = await Promise.all([
      cache.replay(URL, pairs({'accept-encoding': 'gzip'}), origin),
      cache.replay(URL, pairs({'accept-encoding': 'gzip'}), origin),
      cache.replay(URL, pairs({'accept-encoding': 'gzip'}), origin),
    ]);
    expect(wave.filter((r) => r.outcome === 'miss')).toHaveLength(1);
    expect(wave.filter((r) => r.outcome === 'coalesced')).toHaveLength(2);
    expect(calls()).toBe(1);
  });
});
