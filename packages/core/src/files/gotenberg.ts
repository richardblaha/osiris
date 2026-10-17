const TIMEOUT_MS = 60_000;
const MAX_PDF_BYTES = 50 * 1024 * 1024;

export interface ConvertFile {
  name: string;
  data: Uint8Array;
}

/** Gotenberg (shared, no internet access): HTML through Chromium, office documents through LibreOffice, both to PDF. */
export class GotenbergClient {
  private readonly base: string;

  constructor(
    baseUrl: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {
    this.base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  }

  /** `html` becomes `index.html`; `assets` (images, CSS) sit next to it, referenced by file name. */
  htmlToPdf(html: Uint8Array, assets: ConvertFile[] = []): Promise<Uint8Array> {
    return this.convert("forms/chromium/convert/html", [{ name: "index.html", data: html }, ...assets], {
      printBackground: "true",
      preferCssPageSize: "true",
    });
  }

  officeToPdf(file: ConvertFile): Promise<Uint8Array> {
    return this.convert("forms/libreoffice/convert", [file], {});
  }

  private async convert(route: string, files: ConvertFile[], fields: Record<string, string>): Promise<Uint8Array> {
    const form = new FormData();
    for (const f of files) form.append("files", new Blob([new Uint8Array(f.data)]), f.name);
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    const res = await this.fetchFn(new URL(route, this.base), { method: "POST", body: form, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`Převod do PDF selhal (${res.status}): ${(await res.text()).slice(0, 300)}`);
    const pdf = new Uint8Array(await res.arrayBuffer());
    if (pdf.length > MAX_PDF_BYTES) throw new Error("Výsledné PDF je příliš velké");
    return pdf;
  }
}
