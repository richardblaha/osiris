export interface ChunkOptions {
  /** Target chunk size in characters. Default 1200. */
  chunkSize?: number;
  /** Characters of trailing context carried into the next chunk. Default 200. */
  chunkOverlap?: number;
}

export interface MarkdownChunk {
  /** The chunk text, including a `# heading > sub-heading` breadcrumb line. */
  text: string;
  /** Heading stack at the start of the chunk, outermost first. */
  headingPath: string[];
  /** 0-based position of the chunk within the file. */
  index: number;
  /** 1-based line where the chunk's body starts in the source. */
  startLine: number;
}

const HEADING = /^(#{1,6})\s+(.*)$/;

/**
 * Split Markdown into retrieval-sized chunks along heading boundaries. A chunk
 * never spans two headings of the same or shallower depth; long sections are
 * further split at `chunkSize` with `chunkOverlap` characters of carry-over.
 * Each chunk is prefixed with a `a > b > c` breadcrumb so the embedding sees the
 * section context.
 */
export function chunkMarkdown(source: string, options: ChunkOptions = {}): MarkdownChunk[] {
  const chunkSize = options.chunkSize ?? 1200;
  const overlap = Math.min(options.chunkOverlap ?? 200, Math.floor(chunkSize / 2));

  const lines = source.split('\n');
  const chunks: MarkdownChunk[] = [];
  let headingStack: { depth: number; title: string }[] = [];
  let buffer: string[] = [];
  let bufferStartLine = 1;

  const currentPath = (): string[] => headingStack.map((h) => h.title);

  const flush = (): void => {
    const body = buffer.join('\n').trim();
    buffer = [];
    if (!body) return;
    const path = currentPath();
    const crumb = path.length ? `${path.join(' > ')}\n\n` : '';

    // Split an oversized section into overlapping windows on paragraph breaks.
    let start = 0;
    while (start < body.length) {
      let end = Math.min(start + chunkSize, body.length);
      if (end < body.length) {
        const para = body.lastIndexOf('\n\n', end);
        if (para > start + overlap) end = para;
      }
      const slice = body.slice(start, end).trim();
      if (slice) {
        chunks.push({
          text: `${crumb}${slice}`,
          headingPath: path,
          index: chunks.length,
          startLine: bufferStartLine,
        });
      }
      if (end >= body.length) break;
      start = Math.max(end - overlap, start + 1);
    }
  };

  lines.forEach((line, i) => {
    const match = HEADING.exec(line);
    if (match) {
      flush();
      const depth = match[1]!.length;
      const title = match[2]!.trim();
      headingStack = headingStack.filter((h) => h.depth < depth);
      headingStack.push({ depth, title });
      bufferStartLine = i + 2;
      return;
    }
    if (buffer.length === 0) bufferStartLine = i + 1;
    buffer.push(line);
  });
  flush();

  return chunks.map((c, index) => ({ ...c, index }));
}
