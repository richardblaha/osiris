import { useCallback, useEffect, useState } from 'react';
import type { AgentDefinition, BacklogBoard, CrewRunResult } from '@osiris/protocol';
import { api } from './api.js';

type Tab = 'board' | 'crew' | 'memory';

export function App(): JSX.Element {
  const [tab, setTab] = useState<Tab>('board');
  return (
    <>
      <header>
        <h1>◭ Osiris Console</h1>
        <nav>
          {(['board', 'crew', 'memory'] as Tab[]).map((t) => (
            <button key={t} data-active={tab === t} onClick={() => setTab(t)}>
              {t[0]!.toUpperCase() + t.slice(1)}
            </button>
          ))}
        </nav>
      </header>
      <main>
        {tab === 'board' && <Board />}
        {tab === 'crew' && <Crew />}
        {tab === 'memory' && <Memory />}
      </main>
    </>
  );
}

function Board(): JSX.Element {
  const [board, setBoard] = useState<BacklogBoard | null>(null);
  const [error, setError] = useState<string>();
  const [drag, setDrag] = useState<number | null>(null);
  const [dropCol, setDropCol] = useState<string | null>(null);
  const [type, setType] = useState('feat');
  const [title, setTitle] = useState('');

  const refresh = useCallback(() => {
    api.board().then(setBoard).catch((e: Error) => setError(e.message));
  }, []);
  useEffect(refresh, [refresh]);

  const move = async (id: number, toState: string): Promise<void> => {
    setDrag(null);
    setDropCol(null);
    try {
      await api.moveTask(id, toState);
      refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const create = async (): Promise<void> => {
    if (!title.trim()) return;
    await api.createTask({ type, title: title.trim() });
    setTitle('');
    refresh();
  };

  if (error) return <p className="muted">Backlog unavailable: {error}</p>;
  if (!board) return <p className="muted">Loading…</p>;

  return (
    <>
      <div className="row">
        <select value={type} onChange={(e) => setType(e.target.value)}>
          {['feat', 'bug', 'chore', 'spike', 'docs'].map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
        <input
          placeholder="New task title…"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void create()}
          style={{ flex: 1, minWidth: 200 }}
        />
        <button className="primary" onClick={() => void create()}>
          Add
        </button>
        <span className="muted">branch: {board.branch}</span>
      </div>
      <div className="board">
        {board.states.map((state) => (
          <div
            key={state}
            className={`column${dropCol === state ? ' drop-target' : ''}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDropCol(state);
            }}
            onDragLeave={() => setDropCol((c) => (c === state ? null : c))}
            onDrop={() => drag !== null && void move(drag, state)}
          >
            <h2>
              {state} · {board.tasks.filter((t) => t.state === state).length}
            </h2>
            {board.tasks
              .filter((t) => t.state === state)
              .map((t) => (
                <div key={t.id} className="card" draggable onDragStart={() => setDrag(t.id)}>
                  <div className="type">
                    {t.type} · #{t.id}
                  </div>
                  {t.title}
                </div>
              ))}
          </div>
        ))}
      </div>
    </>
  );
}

function Crew(): JSX.Element {
  const [agents, setAgents] = useState<AgentDefinition[]>([]);
  const [task, setTask] = useState('');
  const [result, setResult] = useState<CrewRunResult | null>(null);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    api.agents().then(setAgents).catch(() => setAgents([]));
  }, []);

  const run = async (): Promise<void> => {
    if (!task.trim()) return;
    setRunning(true);
    setResult(null);
    try {
      const { runId } = await api.startRun(task.trim());
      for (let i = 0; i < 120; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        const r = await api.run(runId);
        if (!('status' in r)) {
          setResult(r);
          break;
        }
      }
    } finally {
      setRunning(false);
    }
  };

  return (
    <>
      <div className="row">
        <input
          placeholder="Task for the crew…"
          value={task}
          onChange={(e) => setTask(e.target.value)}
          style={{ flex: 1, minWidth: 240 }}
        />
        <button className="primary" disabled={running} onClick={() => void run()}>
          {running ? 'Running…' : 'Run crew'}
        </button>
      </div>
      {result && (
        <>
          <p className="muted">
            {result.lead} · {result.finishReason} · {result.delegations.length} delegation(s)
          </p>
          <pre>{result.text || result.error}</pre>
          {result.delegations.map((d, i) => (
            <div key={i} className="agent">
              <strong>
                {d.from} → {d.to}
              </strong>
              <div className="muted">{d.brief}</div>
            </div>
          ))}
        </>
      )}
      <h2 className="muted">Crew</h2>
      {agents.map((a) => (
        <div key={a.name} className="agent">
          <strong>{a.name}</strong> — {a.role}
          <div className="muted">
            {a.specialization}
            {a.delegateTo.length > 0 && ` · delegates to: ${a.delegateTo.join(', ')}`}
          </div>
        </div>
      ))}
    </>
  );
}

function Memory(): JSX.Element {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<{ document: string; source: string; score: number }[]>([]);
  const [note, setNote] = useState<string>();

  const search = async (): Promise<void> => {
    if (!query.trim()) return;
    const res = await api.search(query.trim());
    setHits(res.hits);
    setNote(res.hits.length === 0 ? 'No matches.' : undefined);
  };

  return (
    <>
      <div className="row">
        <input
          placeholder="Search the knowledge base…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void search()}
          style={{ flex: 1, minWidth: 240 }}
        />
        <button className="primary" onClick={() => void search()}>
          Search
        </button>
        <button onClick={() => void api.reindex().then(() => setNote('Reindexed.'))}>Reindex</button>
      </div>
      {note && <p className="muted">{note}</p>}
      {hits.map((h, i) => (
        <div key={i} className="hit">
          <div className="muted">
            {h.source} · {h.score.toFixed(2)}
          </div>
          <div>{h.document.slice(0, 400)}</div>
        </div>
      ))}
    </>
  );
}
