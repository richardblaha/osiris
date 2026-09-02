/** Parsing and building of OCI image references for Osiris session images. */

export interface ImageRef {
  /** Registry host[:port], e.g. `registry.osiris.internal`. `undefined` = Docker Hub. */
  registry?: string;
  /** Path without registry or tag, e.g. `workspaces/ws1`. */
  repository: string;
  /** Tag; defaults to `latest` when the ref carries none. */
  tag: string;
}

const HAS_REGISTRY = /^[^/]+[.:][^/]*\//;

export function parseImageRef(ref: string): ImageRef {
  let rest = ref;
  let registry: string | undefined;

  if (HAS_REGISTRY.test(rest)) {
    const slash = rest.indexOf('/');
    registry = rest.slice(0, slash);
    rest = rest.slice(slash + 1);
  }

  // A ':' after the last '/' is a tag; a ':' inside the registry was already consumed.
  const lastSlash = rest.lastIndexOf('/');
  const colon = rest.indexOf(':', lastSlash + 1);
  const tag = colon === -1 ? 'latest' : rest.slice(colon + 1);
  const repository = colon === -1 ? rest : rest.slice(0, colon);

  if (!repository) throw new Error(`invalid image reference: ${ref}`);
  return { registry, repository, tag };
}

export function formatImageRef(ref: ImageRef): string {
  const prefix = ref.registry ? `${ref.registry}/` : '';
  return `${prefix}${ref.repository}:${ref.tag}`;
}

export interface SessionImageInput {
  registry: string;
  workspaceId: string;
  sessionId: string;
}

/** `registry.osiris.internal/workspaces/<ws>:<session>` */
export function sessionImageRef(input: SessionImageInput): string {
  return formatImageRef({
    registry: input.registry,
    repository: `workspaces/${input.workspaceId}`,
    tag: input.sessionId,
  });
}
