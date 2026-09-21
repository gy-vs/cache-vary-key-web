import {useCallback, useEffect, useState} from 'react';
import {Eraser, FlaskConical, Play, Plus, RefreshCw, Save, Send, Trash2} from 'lucide-react';
import type {CacheEntryView, CacheKeyView, CacheStats, ReplayOutcome, ReplayReason} from '../server/cache';

type Summary = {id: string; name: string; revision: number; updatedAt: string; vary: string[] | '*'};
type Row = Summary & {content: string};

type ReplayResultView = {
  outcome: ReplayOutcome;
  reason: ReplayReason;
  key: CacheKeyView;
  response: {id: string; revision: number; body: string};
  stats: CacheStats;
};

type HeaderRow = {name: string; value: string};

const OUTCOME_LABEL: Record<ReplayOutcome, string> = {
  hit: 'Hit',
  miss: 'Miss',
  coalesced: 'Coalesced',
  bypass: 'Bypass',
};

function KeyComponents({keyView}: {keyView: CacheKeyView}) {
  return (
    <div className="key-view">
      <div className="key-line">
        <small>URL</small>
        <code>{keyView.url}</code>
      </div>
      <div className="key-line">
        <small>Vary</small>
        <code>{keyView.vary === '*' ? '*' : keyView.vary.length ? keyView.vary.join(', ') : '(none)'}</code>
      </div>
      {keyView.vary === '*' ? (
        <p className="hint">Vary: * — response is never stored or reused.</p>
      ) : (
        keyView.components.map((component, index) => (
          <div className="key-line" key={component.header + index}>
            <small>{component.header}</small>
            <span className={'kind kind-' + component.kind}>{component.kind}</span>
            {component.kind === 'absent' ? (
              <em>(absent)</em>
            ) : component.values.length === 0 ? (
              <em>(empty)</em>
            ) : (
              <span className="chips">
                {component.values.map((value, valueIndex) => (
                  <span className="chip" key={valueIndex}>
                    {value}
                  </span>
                ))}
              </span>
            )}
          </div>
        ))
      )}
    </div>
  );
}

export default function App() {
  const [items, setItems] = useState<Summary[]>([]);
  const [selected, setSelected] = useState('alpha');
  const [row, setRow] = useState<Row | null>(null);
  const [draft, setDraft] = useState('');
  const [analysis, setAnalysis] = useState<unknown>(null);
  const [status, setStatus] = useState('Ready');

  const [headerRows, setHeaderRows] = useState<HeaderRow[]>([
    {name: 'Accept-Encoding', value: 'gzip, br'},
    {name: 'Accept-Language', value: 'en-US'},
  ]);
  const [replayResult, setReplayResult] = useState<ReplayResultView | null>(null);
  const [entries, setEntries] = useState<CacheEntryView[]>([]);
  const [stats, setStats] = useState<CacheStats | null>(null);

  const refreshEntries = useCallback(async () => {
    const response = await fetch('/api/cache/entries');
    const data = await response.json();
    setEntries(data.entries);
    setStats(data.stats);
  }, []);

  useEffect(() => {
    fetch('/api/experiments').then((r) => r.json()).then(setItems);
    refreshEntries();
  }, [refreshEntries]);

  useEffect(() => {
    setStatus('Loading');
    fetch('/api/experiments/' + selected)
      .then((r) => r.json())
      .then((value: Row) => {
        setRow(value);
        setDraft(value.content);
        setStatus('Loaded');
      });
  }, [selected]);

  async function save() {
    if (!row) return;
    setStatus('Saving');
    const response = await fetch('/api/experiments/' + row.id, {
      method: 'PUT',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({content: draft, revision: row.revision}),
    });
    const value = await response.json();
    if (!response.ok) {
      setStatus('Revision conflict');
      return;
    }
    setRow(value);
    setStatus('Saved');
    await refreshEntries(); // revision bumped: previously stored entries turn stale
  }

  async function analyze() {
    if (!row) return;
    setStatus('Analyzing');
    const response = await fetch('/api/experiments/' + row.id + '/analyze', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({content: draft}),
    });
    setAnalysis(await response.json());
    setStatus('Ready');
  }

  async function replay() {
    const headers: Record<string, string[]> = {};
    for (const {name, value} of headerRows) {
      const trimmed = name.trim();
      if (!trimmed) continue;
      (headers[trimmed] ??= []).push(value);
    }
    setStatus('Replaying');
    const response = await fetch('/api/cache/replay', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({id: selected, headers}),
    });
    setReplayResult(await response.json());
    setStatus('Ready');
    await refreshEntries();
  }

  async function resetCache() {
    await fetch('/api/cache', {method: 'DELETE'});
    setReplayResult(null);
    await refreshEntries();
  }

  function setHeaderRow(index: number, patch: Partial<HeaderRow>) {
    setHeaderRows((rows) => rows.map((row, i) => (i === index ? {...row, ...patch} : row)));
  }

  return (
    <main className="shell">
      <header className="topbar">
        <FlaskConical size={20} />
        <strong>HTTP Cache Lab</strong>
        <small>Local workspace</small>
      </header>
      <section className="workspace">
        <aside className="pane">
          <h2>Items</h2>
          <div className="list">
            {items.map((item) => (
              <button className={item.id === selected ? 'active' : ''} onClick={() => setSelected(item.id)} key={item.id}>
                {item.name}
                <br />
                <small>
                  Revision {item.revision} · Vary: {item.vary === '*' ? '*' : item.vary.join(', ')}
                </small>
              </button>
            ))}
          </div>
        </aside>
        <section className="pane">
          <div className="toolbar">
            <button className="primary" onClick={save}>
              <Save size={15} />
              Save
            </button>
            <button onClick={analyze}>
              <Play size={15} />
              Analyze
            </button>
            <span>{status}</span>
          </div>
          <textarea aria-label="Content" value={draft} onChange={(event) => setDraft(event.target.value)} />
        </section>
        <aside className="pane">
          <h2>Inspection</h2>
          <span className="pill">{selected}</span>
          <pre>{JSON.stringify(analysis ?? row, null, 2)}</pre>
        </aside>
      </section>

      <section className="cache-lab">
        <div className="pane">
          <h2>Replay request</h2>
          <p className="hint">Headers are sent as-is; the server builds the canonical cache key.</p>
          <div className="header-editor">
            {headerRows.map((headerRow, index) => (
              <div className="header-row" key={index}>
                <input
                  aria-label="Header name"
                  placeholder="Header name"
                  value={headerRow.name}
                  onChange={(event) => setHeaderRow(index, {name: event.target.value})}
                />
                <input
                  aria-label="Header value"
                  placeholder="Value (repeat the row for duplicates)"
                  value={headerRow.value}
                  onChange={(event) => setHeaderRow(index, {value: event.target.value})}
                />
                <button
                  aria-label="Remove header"
                  onClick={() => setHeaderRows((rows) => rows.filter((_, i) => i !== index))}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
          <div className="toolbar">
            <button onClick={() => setHeaderRows((rows) => [...rows, {name: '', value: ''}])}>
              <Plus size={15} />
              Header
            </button>
            <button className="primary" onClick={replay}>
              <Send size={15} />
              Replay
            </button>
          </div>
          {replayResult && (
            <div className="replay-result">
              <div className="outcome-line">
                <span className={'outcome outcome-' + replayResult.outcome}>
                  {OUTCOME_LABEL[replayResult.outcome]}
                </span>
                <code>{replayResult.reason}</code>
                <small>
                  response revision {replayResult.response.revision}
                </small>
              </div>
              <KeyComponents keyView={replayResult.key} />
              <pre>{replayResult.response.body}</pre>
            </div>
          )}
        </div>

        <div className="pane">
          <div className="toolbar spread">
            <h2>Cache entries</h2>
            <span className="toolbar">
              <button onClick={refreshEntries}>
                <RefreshCw size={15} />
                Refresh
              </button>
              <button onClick={resetCache}>
                <Eraser size={15} />
                Reset
              </button>
            </span>
          </div>
          {stats && (
            <p className="hint">
              origin fetches {stats.originFetches} · hits {stats.hits} · misses {stats.misses} · coalesced{' '}
              {stats.coalesced} · bypasses {stats.bypasses}
            </p>
          )}
          {entries.length === 0 && <p className="hint">No stored entries.</p>}
          <div className="entries">
            {entries.map((entry, index) => (
              <div className={'entry' + (entry.stale ? ' stale' : '')} key={index}>
                <div className="outcome-line">
                  <strong>{entry.key.url}</strong>
                  <span className={entry.stale ? 'pill pill-stale' : 'pill'}>
                    {entry.stale ? 'stale' : 'fresh'} · rev {entry.revision}
                  </span>
                </div>
                <KeyComponents keyView={entry.key} />
                <pre>{entry.body}</pre>
              </div>
            ))}
          </div>
        </div>
      </section>
    </main>
  );
}
