import { LocalizedError } from "@osiris/platform/i18n.ts";
const TIMEOUT_MS = 180_000;

export interface SiteFile {
  path: string;
  data: Uint8Array;
}

/** The VitePress builder (shared, no network, `server/vitepress`): a site's source files in, the built site out. */
export class VitepressClient {
  private readonly base: string;

  constructor(
    baseUrl: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {
    this.base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  }

  async build(files: SiteFile[]): Promise<SiteFile[]> {
    const form = new FormData();
    for (const f of files) form.append(f.path, new Blob([new Uint8Array(f.data)]), "file");
    const res = await this.fetchFn(new URL("build", this.base), { method: "POST", body: form, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new LocalizedError("errors.vitepress.failed", { status: res.status, detail: (body?.error ?? "").slice(-2000) });
    }
    const out: SiteFile[] = [];
    for (const [path, value] of (await res.formData()).entries()) {
      if (typeof value !== "string") out.push({ path, data: new Uint8Array(await value.arrayBuffer()) });
    }
    return out;
  }
}
