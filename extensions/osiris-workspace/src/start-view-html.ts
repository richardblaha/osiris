import type { RecentProject } from './recent-projects.js';
import { PROVIDERS } from './model-config.js';

export interface StartViewModelRow {
  id: string;
  label: string;
  /** The user's own spec (empty when the class falls back to the default). */
  userSpec: string;
  /** Effective spec shown as the placeholder when `userSpec` is empty. */
  fallbackSpec: string;
  /** Pre-selected in the wizard when the class is unset. */
  suggested: string;
}

export interface StartViewModels {
  rows: StartViewModelRow[];
  /** `<vendor>/<family>` ids from the editor LM API, if available. */
  lmModels: string[];
  /** Keychain keys (env-var names) that currently have a value. */
  secretsPresent: string[];
  hasFolder: boolean;
  /** Scroll to and highlight the Models section on load. */
  focus?: boolean;
}

export interface StartViewState {
  recent: RecentProject[];
  restoreLast: boolean;
  /** A `<script nonce>` value from the webview. */
  nonce: string;
  /** `webview.cspSource` for the Content-Security-Policy. */
  cspSource: string;
  /** Omitted by callers that don't render the model wizard (e.g. unit tests). */
  models?: StartViewModels;
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

function renderModels(m: StartViewModels): string {
  const providerOptions = (selected: string): string =>
    [
      `<option value=""${selected ? '' : ' selected'}>(default)</option>`,
      ...PROVIDERS.map(
        (p) =>
          `<option value="${p.id}"${p.id === selected ? ' selected' : ''}>${escapeHtml(p.label)}</option>`,
      ),
    ].join('');

  const datalists = [
    ...PROVIDERS.filter((p) => p.models.length).map(
      (p) =>
        `<datalist id="ml-${p.id}">${p.models
          .map((mm) => `<option value="${escapeHtml(mm)}"></option>`)
          .join('')}</datalist>`,
    ),
    `<datalist id="ml-vscode-lm">${m.lmModels
      .map((mm) => `<option value="${escapeHtml(mm)}"></option>`)
      .join('')}</datalist>`,
  ].join('');

  const rows = m.rows
    .map((r) => {
      const parsed = /^([\w-]+)\/([\w.:-]+)$/.exec(r.userSpec.trim());
      const prov = parsed?.[1] ?? '';
      const model = parsed?.[2] ?? '';
      const listId = prov ? `ml-${prov}` : 'ml-ollama';
      return `
      <tr class="mrow" data-class="${escapeHtml(r.id)}" data-suggested="${escapeHtml(r.suggested)}">
        <th scope="row">${escapeHtml(r.label)}</th>
        <td><select class="prov" aria-label="${escapeHtml(r.label)} provider">${providerOptions(prov)}</select></td>
        <td>
          <input class="mdl" list="${listId}" value="${escapeHtml(model)}"
                 placeholder="${escapeHtml(r.fallbackSpec)}  (default)" aria-label="${escapeHtml(r.label)} model" />
        </td>
        <td class="hint">${prov ? '' : `suggested: ${escapeHtml(r.suggested)}`}</td>
      </tr>`;
    })
    .join('');

  const keys =
    m.secretsPresent.length || PROVIDERS.some((p) => p.secretEnvKey)
      ? `<p class="keys">API keys (OS keychain): ${PROVIDERS.filter((p) => p.secretEnvKey)
          .map(
            (p) =>
              `<code>${p.secretEnvKey}</code> ${m.secretsPresent.includes(p.secretEnvKey!) ? '✓' : '—'}`,
          )
          .join(' · ')}</p>`
      : '';

  return `
  <section id="models"${m.focus ? ' class="focus"' : ''}>
    <h2>Models — pick a model per task</h2>
    <p class="mnote">Anything left on <em>(default)</em> uses <code>${escapeHtml(
      m.rows[0]?.fallbackSpec ?? 'ollama/qwen3:4b',
    )}</code> — Osiris works fully offline with the bundled local model.</p>
    <table class="models">
      <thead><tr><th>Task</th><th>Provider</th><th>Model</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${datalists}
    ${keys}
    <div class="actions">
      <button id="saveGlobal">Save (User)</button>
      <button id="saveWorkspace" class="secondary"${m.hasFolder ? '' : ' disabled title="Open a folder to save project settings"'}>Save to Project</button>
      <button id="exportModels" class="secondary">Export…</button>
      <button id="importModels" class="secondary">Import…</button>
    </div>
  </section>`;
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
  .actions button:disabled { opacity: 0.5; cursor: default; }
  h2 { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--vscode-descriptionForeground); margin: 1.6rem 0 0.5rem; }
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
  #models .mnote { color: var(--vscode-descriptionForeground); font-size: 0.82rem; margin: 0 0 0.8rem; }
  #models.focus { outline: 2px solid var(--vscode-focusBorder); outline-offset: 8px; border-radius: 4px; }
  table.models { border-collapse: collapse; width: 100%; font-size: 0.83rem; }
  table.models th, table.models td { text-align: left; padding: 0.3rem 0.5rem 0.3rem 0; vertical-align: middle; }
  table.models thead th { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--vscode-descriptionForeground); font-weight: 600; }
  table.models tbody th { font-weight: 500; white-space: nowrap; }
  table.models select, table.models input {
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent); border-radius: 3px; padding: 0.25rem 0.4rem; font-size: 0.82rem; width: 100%;
  }
  table.models .hint { color: var(--vscode-descriptionForeground); font-size: 0.76rem; white-space: nowrap; }
  #models .keys { font-size: 0.78rem; color: var(--vscode-descriptionForeground); margin: 0.6rem 0 0; }
  #models .keys code { color: var(--vscode-foreground); }
  #models .actions { margin-top: 1rem; }
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
${state.models ? renderModels(state.models) : ''}
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

  const models = document.getElementById('models');
  if (models) {
    const syncRow = (row) => {
      const prov = row.querySelector('.prov').value;
      const mdl = row.querySelector('.mdl');
      mdl.setAttribute('list', prov ? 'ml-' + prov : 'ml-ollama');
      row.querySelector('.hint').textContent = prov ? '' : 'suggested: ' + row.dataset.suggested;
    };
    for (const row of models.querySelectorAll('.mrow')) {
      row.querySelector('.prov').onchange = () => syncRow(row);
    }
    const collect = () =>
      [...models.querySelectorAll('.mrow')].map((row) => {
        const prov = row.querySelector('.prov').value;
        const mdl = row.querySelector('.mdl').value.trim();
        return { taskClass: row.dataset.class, spec: prov && mdl ? prov + '/' + mdl : '' };
      });
    document.getElementById('saveGlobal').onclick = () => post('saveModels', { target: 'global', entries: collect() });
    const ws = document.getElementById('saveWorkspace');
    if (ws && !ws.disabled) ws.onclick = () => post('saveModels', { target: 'workspace', entries: collect() });
    document.getElementById('exportModels').onclick = () => post('exportModels');
    document.getElementById('importModels').onclick = () => post('importModels');
    if (models.classList.contains('focus')) models.scrollIntoView({ block: 'start' });
  }
</script>
</body>
</html>`;
}
