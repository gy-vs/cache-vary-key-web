import {describe, expect, it} from 'vitest';
import request from 'supertest';
import {createApp} from '../src/server/index';

describe('service', () => {
  it('loads and conditionally updates a record', async () => {
    const app = createApp();
    const before = await request(app).get('/api/experiments/alpha').expect(200);
    await request(app).put('/api/experiments/alpha').send({content: 'updated', revision: before.body.revision}).expect(200);
    await request(app).put('/api/experiments/alpha').send({content: 'stale', revision: before.body.revision}).expect(409);
  });
});

describe('vary cache api', () => {
  const replay = (app: ReturnType<typeof createApp>, body: Record<string, unknown>) =>
    request(app).post('/api/cache/replay').send(body).expect(200);

  it('returns structured key components and hit reasons', async () => {
    const app = createApp();
    const first = await replay(app, {id: 'alpha', headers: {'Accept-Encoding': 'gzip, br'}});
    expect(first.body).toMatchObject({outcome: 'miss', reason: 'no-entry'});
    expect(first.body.key).toMatchObject({
      url: '/api/experiments/alpha',
      vary: ['accept-encoding', 'accept-language'],
      components: [
        {header: 'accept-encoding', kind: 'list', values: ['br', 'gzip']},
        {header: 'accept-language', kind: 'absent', values: []},
      ],
    });

    const second = await replay(app, {id: 'alpha', headers: {'ACCEPT-ENCODING': 'BR,, GZip'}});
    expect(second.body).toMatchObject({outcome: 'hit', reason: 'key-matched'});
    expect(second.body.response.body).toBe(first.body.response.body);
    expect(second.body.stats.originFetches).toBe(1);
  });

  it('merges repeated header lines and reorderings into the same entry', async () => {
    const app = createApp();
    await replay(app, {id: 'beta', headers: {'accept-encoding': 'gzip, br'}});
    const duplicates = await replay(app, {id: 'beta', headers: {'Accept-Encoding': ['gzip', 'br']}});
    expect(duplicates.body.outcome).toBe('hit');
    const reordered = await replay(app, {id: 'beta', headers: {'accept-encoding': 'br, gzip'}});
    expect(reordered.body.outcome).toBe('hit');

    const entries = await request(app).get('/api/cache/entries').expect(200);
    expect(entries.body.entries).toHaveLength(1);
  });

  it('keeps non-equivalent requests apart and distinguishes missing from empty', async () => {
    const app = createApp();
    const gzip = await replay(app, {id: 'beta', headers: {'accept-encoding': 'gzip'}});
    const br = await replay(app, {id: 'beta', headers: {'accept-encoding': 'br'}});
    expect(br.body.outcome).toBe('miss');
    expect(br.body.response.body).not.toBe(gzip.body.response.body);
    expect(br.body.response.body).toContain('accept-encoding=br');

    const absent = await replay(app, {id: 'beta', headers: {}});
    expect(absent.body.key.components[0].kind).toBe('absent');
    const empty = await replay(app, {id: 'beta', headers: {'accept-encoding': ''}});
    expect(empty.body.outcome).toBe('miss');
    expect(empty.body.key.components[0]).toMatchObject({kind: 'list', values: []});
    expect(empty.body.response.body).not.toBe(absent.body.response.body);

    const entries = await request(app).get('/api/cache/entries').expect(200);
    expect(entries.body.entries).toHaveLength(4);
  });

  it('varies on every field of a multi-field Vary', async () => {
    const app = createApp();
    await replay(app, {id: 'alpha', headers: {'accept-encoding': 'gzip', 'accept-language': 'en-US'}});
    const same = await replay(app, {id: 'alpha', headers: {'accept-encoding': 'gzip', 'accept-language': 'en-us'}});
    expect(same.body.outcome).toBe('hit');
    const otherLang = await replay(app, {id: 'alpha', headers: {'accept-encoding': 'gzip', 'accept-language': 'fr'}});
    expect(otherLang.body.outcome).toBe('miss');
    const entries = await request(app).get('/api/cache/entries').expect(200);
    expect(entries.body.entries).toHaveLength(2);
  });

  it('never reuses Vary:* responses', async () => {
    const app = createApp();
    for (let i = 0; i < 2; i += 1) {
      const result = await replay(app, {id: 'gamma', headers: {'accept-encoding': 'gzip'}});
      expect(result.body).toMatchObject({outcome: 'bypass', reason: 'vary-star'});
      expect(result.body.key.vary).toBe('*');
    }
    const entries = await request(app).get('/api/cache/entries').expect(200);
    expect(entries.body.entries).toHaveLength(0);
    expect(entries.body.stats.bypasses).toBe(2);
    expect(entries.body.stats.originFetches).toBe(2);
  });

  it('preserves the value sequence of non-mergeable headers', async () => {
    const app = createApp();
    await replay(app, {id: 'delta', headers: {'x-lab-flag': ['a', 'b']}});
    const same = await replay(app, {id: 'delta', headers: {'X-Lab-Flag': ['a', 'b']}});
    expect(same.body.outcome).toBe('hit');
    const reversed = await replay(app, {id: 'delta', headers: {'x-lab-flag': ['b', 'a']}});
    expect(reversed.body.outcome).toBe('miss');
    const combined = await replay(app, {id: 'delta', headers: {'x-lab-flag': 'a, b'}});
    expect(combined.body.outcome).toBe('miss');
    const entries = await request(app).get('/api/cache/entries').expect(200);
    expect(entries.body.entries).toHaveLength(3);
  });

  it('marks entries stale after a revision update and refills with the new revision', async () => {
    const app = createApp();
    const before = await replay(app, {id: 'beta', headers: {'accept-encoding': 'gzip'}});
    expect(before.body.response.revision).toBe(5);

    await request(app).put('/api/experiments/beta').send({content: 'beta v6', revision: 5}).expect(200);

    const staleView = await request(app).get('/api/cache/entries').expect(200);
    expect(staleView.body.entries[0].stale).toBe(true);

    const refilled = await replay(app, {id: 'beta', headers: {'accept-encoding': 'gzip'}});
    expect(refilled.body).toMatchObject({outcome: 'miss', reason: 'stale-revision'});
    expect(refilled.body.response.revision).toBe(6);
    expect(refilled.body.response.body).toContain('beta v6');

    const hit = await replay(app, {id: 'beta', headers: {'ACCEPT-ENCODING': 'GZip'}});
    expect(hit.body.outcome).toBe('hit');
    expect(hit.body.response.revision).toBe(6);
  });

  it('a slow stale fill never overwrites a newer revision', async () => {
    const app = createApp();
    await replay(app, {id: 'beta', headers: {'accept-encoding': 'identity'}}); // learn Vary

    // Promise.resolve() subscribes to the supertest thenable so the request
    // actually starts now instead of at the later await.
    const slow = Promise.resolve(replay(app, {id: 'beta', headers: {'accept-encoding': 'gzip'}, delayMs: 150}));
    await new Promise((resolve) => setTimeout(resolve, 30)); // let the slow fill snapshot revision 5
    await request(app).put('/api/experiments/beta').send({content: 'beta v6', revision: 5}).expect(200);
    const fast = await replay(app, {id: 'beta', headers: {'accept-encoding': 'gzip'}});
    expect(fast.body.response.revision).toBe(6);

    const stale = await slow;
    expect(stale.body.response.revision).toBe(5); // the slow caller still gets its own old response

    const after = await replay(app, {id: 'beta', headers: {'accept-encoding': 'gzip'}});
    expect(after.body.outcome).toBe('hit');
    expect(after.body.response.revision).toBe(6);
    expect(after.body.response.body).toContain('beta v6');

    const entries = await request(app).get('/api/cache/entries').expect(200);
    const gzipEntries = entries.body.entries.filter((entry: {key: {components: {values: string[]}[]}}) =>
      entry.key.components.some((component) => component.values.includes('gzip')),
    );
    expect(gzipEntries).toHaveLength(1);
    expect(gzipEntries[0].revision).toBe(6);
  });

  it('coalesces concurrent equivalent fills into a single origin fetch', async () => {
    const app = createApp();
    await replay(app, {id: 'beta', headers: {'accept-encoding': 'identity'}}); // learn Vary
    await request(app).put('/api/experiments/beta').send({content: 'beta v6', revision: 5}).expect(200);

    const wave = await Promise.all([
      replay(app, {id: 'beta', headers: {'Accept-Encoding': 'gzip, br'}, delayMs: 25}),
      replay(app, {id: 'beta', headers: {'accept-encoding': 'br,gzip'}, delayMs: 25}),
      replay(app, {id: 'beta', headers: {'ACCEPT-ENCODING': ['GZip', 'br']}, delayMs: 25}),
    ]);
    const outcomes = wave.map((r) => r.body.outcome).sort();
    expect(outcomes).toEqual(['coalesced', 'coalesced', 'miss']);
    expect(new Set(wave.map((r) => r.body.response.body)).size).toBe(1);

    const entries = await request(app).get('/api/cache/entries').expect(200);
    expect(entries.body.stats.originFetches).toBe(2); // warmup + one shared fill
    expect(entries.body.entries.filter((entry: {stale: boolean}) => !entry.stale)).toHaveLength(1);
  });

  it('resets the cache', async () => {
    const app = createApp();
    await replay(app, {id: 'beta', headers: {'accept-encoding': 'gzip'}});
    await request(app).delete('/api/cache').expect(200);
    const entries = await request(app).get('/api/cache/entries').expect(200);
    expect(entries.body.entries).toHaveLength(0);
    const again = await replay(app, {id: 'beta', headers: {'accept-encoding': 'gzip'}});
    expect(again.body.outcome).toBe('miss');
  });
});
