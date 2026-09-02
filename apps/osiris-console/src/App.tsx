import { useCallback, useEffect, useState } from 'react';
import type {
  AgentDefinition,
  BacklogBoard,
  BacklogTask,
  CrewEvent,
  CrewRunResult,
  TaskHistoryEntry,
} from '@osiris/protocol';
import { client } from './api.js';

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
  const [open, setOpen] = useState<BacklogTask | null>(null);
  const [sync, setSync] = useState<string>();

  const refresh = useCallback(() => {
    client
      .board()
      .then(setBoard)
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(refresh, [refresh]);

  const move = async (id: number, toState: string): Promise<void> => {
    setDrag(null);
    setDropCol(null);
    try {
      await client.moveTask(id, toState);
      refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const create = async (): Promise<void> => {
    if (!title.trim()) return;
    await client.createTask({ type: type as 'feat', title: title.trim() });
    setTitle('');
    refresh();
  };

  const doSync = async (): Promise<void> => {
    setSync('syncing…');
    try {
      const pull = await client.pullBacklog();
      const push = await client.pushBacklog();
      setSync(`pull: ${pull.message} · push: ${push.message}`);
      refresh();
    } catch (e) {
      setSync(`error: ${(e as Error).message}`);
    }
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
        <button onClick={() => void doSync()}>Sync</button>
        <span className="muted">branch: {board.branch}</span>
        {sync && <span className="muted">· {sync}</span>}
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
                <div
                  key={t.id}
                  className="card"
                  draggable
                  onDragStart={() => setDrag(t.id)}
                  onClick={() => setOpen(t)}
                >
                  <div className="type">
                    {t.type} · #{t.id}
                  </div>
                  {t.title}
                </div>
              ))}
          </div>
        ))}
      </div>
      {open && (
        <TaskDrawer
          task={open}
          states={board.states}
          onClose={() => setOpen(null)}
          onChange={refresh}
        />
      )}
    </>
  );
}

function TaskDrawer(props: {
  task: BacklogTask;
  states: string[];
  onClose: () => void;
  onChange: () => void;
}): JSX.Element {
  const { task } = props;
  const [history, setHistory] = useState<TaskHistoryEntry[]>([]);

  useEffect(() => {
    client
      .taskHistory(task.id)
      .then(setHistory)
      .catch(() => setHistory([]));
  }, [task.id]);

  return (
    <div className="drawer-backdrop" onClick={props.onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="row">
          <strong>
            [{task.type}] #{task.id}
          </strong>
          <button onClick={props.onClose} style={{ marginLeft: 'auto' }}>
            ✕
          </button>
        </div>
        <h3>{task.title}</h3>
        <div className="row">
          <span className="muted">move to:</span>
          {props.states
            .filter((s) => s !== task.state)
            .map((s) => (
              <button
                key={s}
                onClick={() =>
                  void client.moveTask(task.id, s).then(() => {
                    props.onChange();
                    props.onClose();
                  })
                }
              >
                {s}
              </button>
            ))}
        </div>
        {task.labels.length > 0 && <p className="muted">labels: {task.labels.join(', ')}</p>}
        <pre>{task.body || '(no description)'}</pre>
        <h2 className="muted">History</h2>
        {history.length === 0 && <p className="muted">no commits yet</p>}
        {history.map((h) => (
          <div key={h.hash} className="hit">
            <span className="muted">
              {h.date} · {h.hash.slice(0, 7)}
            </span>{' '}
            {h.subject}
          </div>
        ))}
      </aside>
    </div>
  );
}

function Crew(): JSX.Element {
  const [agents, setAgents] = useState<AgentDefinition[]>([]);
  const [task, setTask] = useState('');
  const [result, setResult] = useState<CrewRunResult | null>(null);
  const [feed, setFeed] = useState<string[]>([]);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    client
      .agents()
      .then(setAgents)
      .catch(() => setAgents([]));
  }, []);

  const run = async (): Promise<void> => {
    if (!task.trim()) return;
    setRunning(true);
    setResult(null);
    setFeed([]);
    try {
      for await (const e of client.run$({ task: task.trim() })) {
        setFeed((f) => [...f, describe(e)]);
        if (e.type === 'run.finish') setResult(e.result);
      }
    } catch (err) {
      setFeed((f) => [...f, `error: ${(err as Error).message}`]);
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
          onKeyDown={(e) => e.key === 'Enter' && void run()}
          style={{ flex: 1, minWidth: 240 }}
        />
        <button className="primary" disabled={running} onClick={() => void run()}>
          {running ? 'Running…' : 'Run crew'}
        </button>
      </div>
      {feed.length > 0 && <pre>{feed.join('\n')}</pre>}
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

function describe(e: CrewEvent): string {
  switch (e.type) {
    case 'agent.start':
      return `▸ ${e.agent} (depth ${e.depth})`;
    case 'delegate':
      return `  ${e.from} → ${e.to}: ${e.brief}`;
    case 'agent.tool':
      return `    ${e.agent} · tool ${e.tool}`;
    case 'blackboard':
      return `  · [${e.entry.kind}] ${e.entry.agent}: ${e.entry.text.slice(0, 100)}`;
    case 'agent.finish':
      return `✓ ${e.agent}`;
    case 'run.finish':
      return `— ${e.result.finishReason}`;
    default:
      return '';
  }
}

function Memory(): JSX.Element {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<{ document: string; source: string; score: number }[]>([]);
  const [note, setNote] = useState<string>();

  const search = async (): Promise<void> => {
    if (!query.trim()) return;
    const res = await client.search({ query: query.trim(), k: 6 });
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
        <button
          onClick={() =>
            void client.reindex().then((r) => setNote(`Reindexed — ${r.chunksUpserted} chunks.`))
          }
        >
          Reindex
        </button>
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
