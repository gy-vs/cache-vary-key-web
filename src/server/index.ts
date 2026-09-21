import express from 'express';
import {fileURLToPath} from 'node:url';
import {
  VaryCache,
  buildKeyComponents,
  type HeaderPair,
  type VarySpec,
} from './cache';

type RecordRow = {
  id: string;
  name: string;
  revision: number;
  content: string;
  updatedAt: string;
  /** Vary spec this resource's origin responses emit. */
  vary: VarySpec;
};

function seed(): RecordRow[] {
  return [
    {id: 'alpha', name: 'Primary cache simulations', revision: 3, content: 'cache simulations: alpha\nstate: active', updatedAt: new Date(0).toISOString(), vary: ['accept-encoding', 'accept-language']},
    {id: 'beta', name: 'Secondary cache simulations', revision: 5, content: 'cache simulations: beta\nstate: review', updatedAt: new Date(1000).toISOString(), vary: ['accept-encoding']},
    {id: 'gamma', name: 'Never-reusable responses', revision: 1, content: 'cache simulations: gamma\nstate: star', updatedAt: new Date(2000).toISOString(), vary: '*'},
    {id: 'delta', name: 'Custom header variants', revision: 2, content: 'cache simulations: delta\nstate: flagged', updatedAt: new Date(3000).toISOString(), vary: ['x-lab-flag']},
  ];
}

const urlFor = (id: string) => '/api/experiments/' + id;

/** Convert a JSON header map (string | string[] values) into ordered header lines. */
function toPairs(input: unknown): HeaderPair[] {
  const pairs: HeaderPair[] = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) return pairs;
  for (const [name, value] of Object.entries(input as Record<string, unknown>)) {
    if (Array.isArray(value)) {
      for (const item of value) pairs.push([name, String(item)]);
    } else if (value !== null && value !== undefined) {
      pairs.push([name, String(value)]);
    }
  }
  return pairs;
}

export function createApp() {
  const app = express();
  app.use(express.json({limit: '1mb'}));

  const rows = seed();
  const cache = new VaryCache((url) => rows.find((row) => urlFor(row.id) === url)?.revision ?? -1);

  /**
   * Simulated origin: snapshots the row (so a slow fill keeps the revision it
   * started with), then emits a body that reflects the canonical vary
   * components — equivalent requests negotiate the same variant, and content
   * crossing between non-equivalent requests is observable.
   */
  function originFor(row: RecordRow, delayMs: number) {
    return async (pairs: HeaderPair[]) => {
      const snapshot = {revision: row.revision, content: row.content};
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      const components = row.vary === '*' ? [] : buildKeyComponents(row.vary, pairs);
      const variant =
        components.length === 0
          ? '(none)'
          : components
              .map((c) => `${c.header}=${c.kind === 'absent' ? '(absent)' : c.values.length ? c.values.join('|') : '(empty)'}`)
              .join('; ');
      return {
        revision: snapshot.revision,
        body: `${snapshot.content}\nrevision: ${snapshot.revision}\nvariant: ${variant}`,
        vary: row.vary,
      };
    };
  }

  app.get('/api/bootstrap', (_req, res) => res.json({family: 'http-cache', count: rows.length}));
  app.get('/api/experiments', (_req, res) =>
    res.json(rows.map(({content, ...row}) => ({...row, vary: row.vary}))),
  );
  app.get('/api/experiments/:id', (req, res) => {
    const row = rows.find((value) => value.id === req.params.id);
    if (!row) return res.status(404).json({error: 'not_found'});
    res
      .set('ETag', String(row.revision))
      .set('Vary', row.vary === '*' ? '*' : row.vary.join(', '))
      .json(row);
  });
  app.put('/api/experiments/:id', (req, res) => {
    const row = rows.find((value) => value.id === req.params.id);
    if (!row) return res.status(404).json({error: 'not_found'});
    if (req.body.revision !== row.revision) return res.status(409).json({error: 'revision_conflict', current: row});
    row.content = String(req.body.content ?? '');
    row.revision += 1;
    row.updatedAt = new Date().toISOString();
    res.json(row);
  });
  app.post('/api/experiments/:id/analyze', async (req, res) => {
    const row = rows.find((value) => value.id === req.params.id);
    if (!row) return res.status(404).json({error: 'not_found'});
    await new Promise((resolve) => setTimeout(resolve, req.params.id === 'alpha' ? 100 : 20));
    res.json({id: row.id, revision: row.revision, lines: String(req.body.content ?? row.content).split(/\r?\n/).length, diagnostics: []});
  });

  /**
   * Replay a request through the Vary-aware cache. The server owns all key
   * computation; clients receive the structured key components and the hit
   * reason and only render them.
   */
  app.post('/api/cache/replay', async (req, res) => {
    const row = rows.find((value) => value.id === req.body?.id);
    if (!row) return res.status(404).json({error: 'not_found'});
    const pairs = toPairs(req.body?.headers);
    const delayMs = Math.min(Math.max(Number(req.body?.delayMs) || 0, 0), 2000);
    const result = await cache.replay(urlFor(row.id), pairs, originFor(row, delayMs));
    res.json({
      outcome: result.outcome,
      reason: result.reason,
      key: result.key,
      response: {id: row.id, revision: result.response.revision, body: result.response.body},
      stats: cache.stats(),
    });
  });

  app.get('/api/cache/entries', (_req, res) => {
    res.json({entries: cache.entriesView(), stats: cache.stats()});
  });

  app.delete('/api/cache', (_req, res) => {
    cache.reset();
    res.json({cleared: true, stats: cache.stats()});
  });

  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createApp().listen(4174, '127.0.0.1', () => console.log('server http://127.0.0.1:4174'));
}
