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
});
