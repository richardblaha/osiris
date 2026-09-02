import { describe, expect, it } from 'vitest';
import { renderStartHtml } from '../src/start-view-html.js';
import type { RecentProject } from '../src/recent-projects.js';

const recent: RecentProject[] = [
  {
    hostPath: '/home/me/<script>',
    name: 'proj-1',
    hash: 'abc123abc123',
    serverPort: 8000,
    lastOpenedAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
  },
];

describe('renderStartHtml', () => {
  it('lists recent projects with escaped paths and a relative time', () => {
    const html = renderStartHtml({ recent, restoreLast: true, nonce: 'N0NCE', cspSource: 'vscode-webview://x' });
    expect(html).toContain('data-hash="abc123abc123"');
    expect(html).toContain('proj-1');
    expect(html).not.toContain('/home/me/<script>');
    expect(html).toContain('&#60;script&#62;');
    expect(html).toMatch(/\dh ago/);
    expect(html).toMatch(/id="restore"\s+checked/);
  });

  it('locks the CSP to the nonce and cspSource, and shows the empty state', () => {
    const html = renderStartHtml({ recent: [], restoreLast: false, nonce: 'N0NCE', cspSource: 'vscode-webview://x' });
    expect(html).toContain("script-src 'nonce-N0NCE'");
    expect(html).toContain('style-src vscode-webview://x');
    expect(html).toContain('No projects yet');
    expect(html).not.toMatch(/id="restore"\s+checked/);
  });

  it('omits the Models section when no model state is supplied', () => {
    const html = renderStartHtml({ recent: [], restoreLast: false, nonce: 'N', cspSource: 'x' });
    expect(html).not.toContain('id="models"');
  });

  it('renders one row per task class with a pre-filled provider/model', () => {
    const html = renderStartHtml({
      recent: [],
      restoreLast: false,
      nonce: 'N',
      cspSource: 'x',
      models: {
        rows: [
          { id: 'chat', label: 'Chat', userSpec: '', fallbackSpec: 'ollama/qwen3:4b', suggested: 'ollama/qwen3:4b' },
          { id: 'planning', label: 'Planning', userSpec: 'anthropic/claude-opus-5', fallbackSpec: 'ollama/qwen3:4b', suggested: 'anthropic/claude-opus-5' },
        ],
        lmModels: ['copilot/gpt-4o'],
        secretsPresent: ['ANTHROPIC_API_KEY'],
        hasFolder: false,
        focus: true,
      },
    });
    expect(html).toContain('id="models"');
    expect(html).toContain('data-class="chat"');
    expect(html).toContain('<option value="anthropic" selected>');
    expect(html).toContain('value="claude-opus-5"');
    expect(html).toMatch(/id="saveWorkspace"[^>]*disabled/); // no folder
    expect(html).toContain('<code>ANTHROPIC_API_KEY</code> ✓');
    expect(html).toContain('copilot/gpt-4o');
    expect(html).toContain('class="focus"');
  });
});
