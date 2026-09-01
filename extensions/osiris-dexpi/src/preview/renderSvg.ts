/**
 * Pure DEXPI-model → SVG renderer. No DOM, no VS Code — used both by the webview
 * and by the `osiris-dexpi.exportSvg` command, and unit-tested directly.
 *
 * The layout uses whatever coordinates the file provides; there is no auto-layout.
 */
import type { DexpiModel, DexpiNode, DexpiPosition } from '@osiris/shared-core';

export interface RenderOptions {
  padding?: number;
  /** Fallback box size for equipment without an Extent, in model units. */
  defaultSize?: number;
  accent?: string;
  accentAlt?: string;
  background?: string;
  foreground?: string;
  /** IDs to highlight (selection sync from the issues list). */
  highlight?: string[];
}

interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

const DEFAULTS = {
  padding: 40,
  defaultSize: 30,
  accent: '#00FFFF',
  accentAlt: '#FF00FF',
  background: '#121212',
  foreground: '#e0e0e0',
} as const;

function escapeXml(value: string): string {
  return value.replace(/[<>&"']/g, (c) =>
    c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '&' ? '&amp;' : c === '"' ? '&quot;' : '&apos;',
  );
}

function collectPoints(model: DexpiModel): DexpiPosition[] {
  const points: DexpiPosition[] = [];
  for (const eq of model.equipment) {
    if (eq.position) {
      points.push(eq.position);
      if (eq.extent) {
        points.push({ x: eq.position.x + eq.extent.width, y: eq.position.y + eq.extent.height });
      }
    }
  }
  for (const segment of model.segments) {
    points.push(...segment.centerLine);
  }
  return points;
}

function computeBounds(points: DexpiPosition[], fallbackSize: number): Bounds {
  if (points.length === 0) {
    return { minX: 0, minY: 0, maxX: fallbackSize * 10, maxY: fallbackSize * 10 };
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  if (minX === maxX) {
    maxX += fallbackSize;
  }
  if (minY === maxY) {
    maxY += fallbackSize;
  }
  return { minX, minY, maxX, maxY };
}

function centerOf(node: DexpiNode, size: number): DexpiPosition | undefined {
  if (!node.position) {
    return undefined;
  }
  const w = node.extent?.width ?? size;
  const h = node.extent?.height ?? size;
  return { x: node.position.x + w / 2, y: node.position.y + h / 2 };
}

export function renderDexpiSvg(model: DexpiModel, options: RenderOptions = {}): string {
  const opts = { ...DEFAULTS, ...options };
  const highlight = new Set(options.highlight ?? []);
  const points = collectPoints(model);
  const bounds = computeBounds(points, opts.defaultSize);

  // DEXPI's Y axis points up; SVG's points down. Flip via a transform.
  const width = bounds.maxX - bounds.minX + opts.padding * 2;
  const height = bounds.maxY - bounds.minY + opts.padding * 2;
  const tx = -bounds.minX + opts.padding;
  const ty = -bounds.minY + opts.padding;

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width.toFixed(1)} ${height.toFixed(1)}" ` +
      `width="${width.toFixed(1)}" height="${height.toFixed(1)}" font-family="monospace">`,
  );
  parts.push(`<rect x="0" y="0" width="100%" height="100%" fill="${opts.background}"/>`);
  parts.push(`<g transform="translate(${tx.toFixed(1)} ${(height - ty).toFixed(1)}) scale(1 -1)">`);

  // Piping segments.
  for (const segment of model.segments) {
    if (segment.centerLine.length >= 2) {
      const d = segment.centerLine
        .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
        .join(' ');
      const stroke = segment.id && highlight.has(segment.id) ? opts.accentAlt : opts.accent;
      parts.push(
        `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="1.5" data-id="${escapeXml(segment.id ?? '')}"/>`,
      );
    }
  }

  // Equipment boxes + nozzles + labels.
  for (const eq of model.equipment) {
    if (!eq.position) {
      continue;
    }
    const w = eq.extent?.width ?? opts.defaultSize;
    const h = eq.extent?.height ?? opts.defaultSize;
    const selected = eq.id ? highlight.has(eq.id) : false;
    parts.push(
      `<rect x="${eq.position.x.toFixed(1)}" y="${eq.position.y.toFixed(1)}" ` +
        `width="${w.toFixed(1)}" height="${h.toFixed(1)}" ` +
        `fill="${selected ? opts.accentAlt : 'none'}" fill-opacity="${selected ? 0.25 : 0}" ` +
        `stroke="${selected ? opts.accentAlt : opts.foreground}" stroke-width="1.5" ` +
        `data-id="${escapeXml(eq.id ?? '')}"/>`,
    );
    const label = eq.componentName ?? eq.id ?? eq.componentClass ?? 'Equipment';
    const center = centerOf(eq, opts.defaultSize) ?? eq.position;
    parts.push(
      `<text x="${center.x.toFixed(1)}" y="${center.y.toFixed(1)}" fill="${opts.foreground}" ` +
        `font-size="8" text-anchor="middle" transform="scale(1 -1) translate(0 ${(-2 * center.y).toFixed(1)})">` +
        `${escapeXml(String(label))}</text>`,
    );
    for (const nozzle of eq.nozzles) {
      const np = nozzle.position ?? { x: eq.position.x, y: eq.position.y };
      parts.push(
        `<circle cx="${np.x.toFixed(1)}" cy="${np.y.toFixed(1)}" r="2" fill="${opts.accent}" ` +
          `data-id="${escapeXml(nozzle.id ?? '')}"/>`,
      );
    }
  }

  parts.push('</g>');
  parts.push('</svg>');
  return parts.join('\n');
}
