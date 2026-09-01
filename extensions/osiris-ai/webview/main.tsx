/** Osiris AI agent panel — a small React app hosted in a WebviewView. */
import { StrictMode, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './panel.css';
import type { PanelInbound, PanelOutbound } from '../src/protocol.js';

interface VsCodeApi {
  postMessage(msg: PanelInbound): void;
  getState(): unknown;
  setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;
const vscodeApi = acquireVsCodeApi();

type TranscriptItem =
  | { kind: 'user'; text: string }
  | { kind: 'agent'; text: string }
  | { kind: 'tool'; name: string; input: unknown; result?: string; isError?: boolean };

interface State {
  busy: boolean;
  provider: string;
  tools: string[];
  mcp: { id: string; running: boolean; toolCount: number; error?: string }[];
}

function App(): JSX.Element {
  const [state, setState] = useState<State>({ busy: false, provider: '…', tools: [], mcp: [] });
  const [transcript, setTranscript] = useState<TranscriptItem[]>([]);
  const [draft, setDraft] = useState('');
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (event: MessageEvent<PanelOutbound>): void => {
      const msg = event.data;
      switch (msg.type) {
        case 'state':
          setState({ busy: msg.busy, provider: msg.provider, tools: msg.tools, mcp: msg.mcp });
          break;
        case 'agent/run-started':
          setTranscript((t) => [
            ...t,
            { kind: 'user', text: msg.prompt },
            { kind: 'agent', text: '' },
          ]);
          break;
        case 'agent/token':
          setTranscript((t) => {
            const copy = [...t];
            for (let i = copy.length - 1; i >= 0; i--) {
              const item = copy[i]!;
              if (item.kind === 'agent') {
                copy[i] = { ...item, text: item.text + msg.text };
                break;
              }
            }
            return copy;
          });
          break;
        case 'agent/tool':
          setTranscript((t) => [
            ...t,
            {
              kind: 'tool',
              name: msg.name,
              input: msg.input,
              result: msg.result,
              isError: msg.isError,
            },
            { kind: 'agent', text: '' },
          ]);
          break;
        case 'agent/run-finished':
          if (msg.error) {
            setTranscript((t) => [
              ...t,
              { kind: 'agent', text: `\n⚠ ${msg.finishReason}: ${msg.error}` },
            ]);
          }
          break;
        default:
          break;
      }
    };
    window.addEventListener('message', handler);
    vscodeApi.postMessage({ type: 'ready' });
    return () => window.removeEventListener('message', handler);
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [transcript]);

  const send = (): void => {
    const prompt = draft.trim();
    if (!prompt || state.busy) {
      return;
    }
    vscodeApi.postMessage({ type: 'user/send', prompt });
    setDraft('');
  };

  const mcpPills = useMemo(
    () =>
      state.mcp.map((s) => (
        <span
          key={s.id}
          className={`pill ${s.error ? 'err' : s.running ? 'ok' : ''}`}
          title={s.error ?? ''}
        >
          {s.id} · {s.error ? 'error' : `${s.toolCount} tools`}
        </span>
      )),
    [state.mcp],
  );

  return (
    <>
      <div className="status">
        <span className="pill">provider: {state.provider}</span>
        <span className="pill">{state.tools.length} tools</span>
        {mcpPills}
        <button onClick={() => vscodeApi.postMessage({ type: 'reloadMcp' })}>reload MCP</button>
      </div>

      <div className="transcript">
        {transcript.map((item, i) =>
          item.kind === 'tool' ? (
            <div key={i} className={`tool ${item.isError ? 'err' : ''}`}>
              <div>
                ▸ {item.name}({JSON.stringify(item.input)})
              </div>
              {item.result !== undefined && <div>{item.result.slice(0, 2000)}</div>}
            </div>
          ) : (
            <div key={i} className={`msg ${item.kind}`}>
              <span className="who">{item.kind === 'user' ? 'you' : 'osiris'}</span>
              {item.text}
            </div>
          ),
        )}
        <div ref={endRef} />
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <textarea
          value={draft}
          placeholder="Ask the Osiris agent…  (Enter to send, Shift+Enter for newline)"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        {state.busy ? (
          <button type="button" onClick={() => vscodeApi.postMessage({ type: 'cancel' })}>
            stop
          </button>
        ) : (
          <button type="submit" disabled={!draft.trim()}>
            send
          </button>
        )}
      </form>
    </>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
