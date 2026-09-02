import type { RecentProject } from './recent-projects.js';

export interface StartViewState {
  recent: RecentProject[];
  restoreLast: boolean;
  /** A `<script nonce>` value from the webview. */
  nonce: string;
  /** `webview.cspSource` for the Content-Security-Policy. */
  cspSource: string;
}

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function relativeTime(iso: string, now = Date.now()): string {
  const diff = now - Date.parse(iso);
  if (Number.isNaN(diff)) return '';
  const mins = Math.round(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** Render the Osiris Start webview. Pure — the provider only supplies state. */
export function renderStartHtml(state: StartViewState): string {
  const rows =
    state.recent.length === 0
      ? '<p class="empty">No projects yet. Open or create one to get started.</p>'
      : state.recent
          .map(
            (p) => `
      <li class="proj">
        <button class="open" data-hash="${escapeHtml(p.hash)}" title="Open in DevContainer">
          <span class="name">${escapeHtml(p.name)}</span>
          <span class="path">${escapeHtml(p.hostPath)}</span>
        </button>
        <span class="when">${relativeTime(p.lastOpenedAt)}</span>
        <button class="forget" data-hash="${escapeHtml(p.hash)}" title="Remove from list" aria-label="Remove">&times;</button>
      </li>`,
          )
          .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${state.cspSource} 'unsafe-inline'; script-src 'nonce-${state.nonce}';" />
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 1.4rem 1.6rem; }
  h1 { font-size: 1.3rem; margin: 0 0 0.2rem; }
  .sub { color: var(--vscode-descriptionForeground); margin: 0 0 1.6rem; }
  .actions { display: flex; gap: 0.6rem; margin-bottom: 1.8rem; flex-wrap: wrap; }
  .actions button {
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border: none; padding: 0.5rem 0.9rem; border-radius: 4px; cursor: pointer; font-size: 0.85rem;
  }
  .actions button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .actions button:hover { background: var(--vscode-button-hoverBackground); }
  h2 { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--vscode-descriptionForeground); margin: 0 0 0.5rem; }
  ul { list-style: none; margin: 0; padding: 0; }
  .proj { display: flex; align-items: center; gap: 0.6rem; padding: 0.15rem 0; }
  .proj .open {
    flex: 1; text-align: left; background: none; border: none; color: inherit; cursor: pointer;
    padding: 0.45rem 0.5rem; border-radius: 4px; display: flex; flex-direction: column; gap: 0.1rem; min-width: 0;
  }
  .proj .open:hover { background: var(--vscode-list-hoverBackground); }
  .proj .name { font-weight: 600; }
  .proj .path { font-size: 0.78rem; color: var(--vscode-descriptionForeground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .proj .when { font-size: 0.75rem; color: var(--vscode-descriptionForeground); flex: none; }
  .proj .forget { background: none; border: none; color: var(--vscode-descriptionForeground); cursor: pointer; font-size: 1rem; flex: none; }
  .proj .forget:hover { color: var(--vscode-foreground); }
  .empty { color: var(--vscode-descriptionForeground); }
  .pref { margin-top: 2rem; font-size: 0.85rem; display: flex; align-items: center; gap: 0.5rem; }
</style>
</head>
<body>
  <h1>Osiris</h1>
  <p class="sub">Every project runs inside its own DevContainer — with the agent, tasks and tools.</p>

  <div class="actions">
    <button id="new">New Project…</button>
    <button id="open" class="secondary">Open Folder…</button>
  </div>

  <h2>Recent</h2>
  <ul id="recent">${rows}</ul>

  <label class="pref">
    <input type="checkbox" id="restore" ${state.restoreLast ? 'checked' : ''} />
    Reopen the last project when Osiris starts
  </label>

<script nonce="${state.nonce}">
  const vscode = acquireVsCodeApi();
  const post = (type, payload) => vscode.postMessage({ type, ...payload });
  document.getElementById('new').onclick = () => post('newProject');
  document.getElementById('open').onclick = () => post('openFolder');
  document.getElementById('restore').onchange = (e) => post('setRestoreLast', { value: e.target.checked });
  for (const el of document.querySelectorAll('.open')) {
    el.onclick = () => post('openRecent', { hash: el.dataset.hash });
  }
  for (const el of document.querySelectorAll('.forget')) {
    el.onclick = () => post('forget', { hash: el.dataset.hash });
  }
</script>
</body>
</html>`;
}
