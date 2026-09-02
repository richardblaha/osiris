/** The Osiris console panel — a small React app hosted in a WebviewView. */
import { StrictMode, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ConsoleClient, type BacklogBoard, type CrewEvent } from '@osiris/protocol';
import './panel.css';

declare global {
  interface Window {
    __OSIRIS__?: { serverUrl: string; token?: string };
  }
}

const cfg = window.__OSIRIS__ ?? { serverUrl: 'http://localhost:8080' };
const client = new ConsoleClient({ baseUrl: cfg.serverUrl, token: cfg.token });

type Tab = 'board' | 'crew';

function App(): JSX.Element {
  const [tab, setTab] = useState<Tab>('board');
  return (
    <StrictMode>
      <nav>
        {(['board', 'crew'] as Tab[]).map((t) => (
          <button key={t} data-active={tab === t} onClick={() => setTab(t)}>
            {t[0]!.toUpperCase() + t.slice(1)}
          </button>
        ))}
        <button style={{ marginLeft: 'auto' }} onClick={() => location.reload()}>
          ↻
        </button>
      </nav>
      {tab === 'board' ? <Board /> : <Crew />}
      <p className="muted" style={{ fontSize: 11, marginTop: 12 }}>
        server: {cfg.serverUrl}
      </p>
    </StrictMode>
  );
}

function Board(): JSX.Element {
  const [board, setBoard] = useState<BacklogBoard | null>(null);
  const [err, setErr] = useState<string>();
  const [title, setTitle] = useState('');
  const [type, setType] = useState('feat');

  const refresh = useCallback(() => {
    client
      .board()
      .then(setBoard)
      .catch((e: Error) => setErr(e.message));
  }, []);
  useEffect(refresh, [refresh]);

  if (err) return <p className="muted">Can't reach the server: {err}</p>;
  if (!board) return <p className="muted">Loading…</p>;

  const add = async (): Promise<void> => {
    if (!title.trim()) return;
    await client.createTask({ type: type as 'feat', title: title.trim() });
    setTitle('');
    refresh();
  };

  return (
    <>
      <div className="row">
        <select value={type} onChange={(e) => setType(e.target.value)}>
          {['feat', 'bug', 'chore', 'spike', 'docs'].map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
        <input
          placeholder="New task…"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void add()}
        />
        <button className="primary" onClick={() => void add()}>
          Add
        </button>
      </div>
      {board.states.map((state) => {
        const items = board.tasks.filter((t) => t.state === state);
        return (
          <div key={state} className="col">
            <h3>
              {state} · {items.length}
            </h3>
            {items.map((t) => (
              <div key={t.id} className="card">
                <div className="type">
                  {t.type} · #{t.id}
                </div>
                {t.title}
                <div className="actions">
                  {board.states
                    .filter((s) => s !== state)
                    .map((s) => (
                      <button key={s} onClick={() => void client.moveTask(t.id, s).then(refresh)}>
                        → {s}
                      </button>
                    ))}
                </div>
              </div>
            ))}
          </div>
        );
      })}
    </>
  );
}

function describe(e: CrewEvent): string {
  switch (e.type) {
    case 'agent.start':
      return `\n▸ ${e.agent} (depth ${e.depth})`;
    case 'agent.text':
      return e.text;
    case 'delegate':
      return `\n  ↳ ${e.from} → ${e.to}: ${e.brief}`;
    case 'agent.tool':
      return `\n  · ${e.agent} uses ${e.tool}`;
    case 'blackboard':
      return `\n  [${e.entry.kind}] ${e.entry.agent}: ${e.entry.text}`;
    case 'run.finish':
      return `\n\n── ${e.result.finishReason} ──\n${e.result.text || e.result.error || ''}`;
    default:
      return '';
  }
}

function Crew(): JSX.Element {
  const [task, setTask] = useState('');
  const [feed, setFeed] = useState('');
  const [busy, setBusy] = useState(false);
  const [agents, setAgents] = useState<string[]>([]);

  useEffect(() => {
    client
      .agents()
      .then((a) => setAgents(a.map((x) => x.name)))
      .catch(() => setAgents([]));
  }, []);

  const run = async (): Promise<void> => {
    if (!task.trim()) return;
    setBusy(true);
    setFeed('');
    try {
      for await (const e of client.run$({ task: task.trim() })) {
        setFeed((f) => f + describe(e));
      }
    } catch (e) {
      setFeed((f) => `${f}\nerror: ${(e as Error).message}`);
    } finally {
      setBusy(false);
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
        />
        <button className="primary" disabled={busy} onClick={() => void run()}>
          {busy ? '…' : 'Run'}
        </button>
      </div>
      <p className="muted" style={{ fontSize: 11 }}>
        crew: {agents.join(', ') || '—'}
      </p>
      {feed && <pre>{feed}</pre>}
    </>
  );
}

const root = document.getElementById('root');
if (root) createRoot(root).render(<App />);
