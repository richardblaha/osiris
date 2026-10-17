/** File types a tenant may store, by extension. Anything else is refused, so the store never holds executables. */
export const FILE_TYPES: Record<string, { mime: string; text: boolean }> = {
  txt: { mime: "text/plain", text: true },
  md: { mime: "text/markdown", text: true },
  csv: { mime: "text/csv", text: true },
  json: { mime: "application/json", text: true },
  xml: { mime: "application/xml", text: true },
  html: { mime: "text/html", text: true },
  htm: { mime: "text/html", text: true },
  css: { mime: "text/css", text: true },
  js: { mime: "text/javascript", text: true },
  svg: { mime: "image/svg+xml", text: true },
  ics: { mime: "text/calendar", text: true },
  vcf: { mime: "text/vcard", text: true },
  png: { mime: "image/png", text: false },
  jpg: { mime: "image/jpeg", text: false },
  jpeg: { mime: "image/jpeg", text: false },
  gif: { mime: "image/gif", text: false },
  webp: { mime: "image/webp", text: false },
  ico: { mime: "image/x-icon", text: false },
  pdf: { mime: "application/pdf", text: false },
  docx: { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", text: false },
  xlsx: { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", text: false },
  pptx: { mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", text: false },
  odt: { mime: "application/vnd.oasis.opendocument.text", text: false },
  ods: { mime: "application/vnd.oasis.opendocument.spreadsheet", text: false },
  woff: { mime: "font/woff", text: false },
  woff2: { mime: "font/woff2", text: false },
};

/** Leading bytes each binary type must start with, so a renamed executable can't pass as an image. */
const MAGIC: Record<string, number[][]> = {
  png: [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  jpg: [[0xff, 0xd8, 0xff]],
  jpeg: [[0xff, 0xd8, 0xff]],
  gif: [[0x47, 0x49, 0x46, 0x38]],
  webp: [[0x52, 0x49, 0x46, 0x46]],
  ico: [[0x00, 0x00, 0x01, 0x00]],
  pdf: [[0x25, 0x50, 0x44, 0x46, 0x2d]],
  // Office Open XML and OpenDocument are zip archives.
  docx: [[0x50, 0x4b, 0x03, 0x04]],
  xlsx: [[0x50, 0x4b, 0x03, 0x04]],
  pptx: [[0x50, 0x4b, 0x03, 0x04]],
  odt: [[0x50, 0x4b, 0x03, 0x04]],
  ods: [[0x50, 0x4b, 0x03, 0x04]],
  woff: [[0x77, 0x4f, 0x46, 0x46]],
  woff2: [[0x77, 0x4f, 0x46, 0x32]],
};

export const extensionOf = (path: string) => {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
};

export const fileType = (path: string) => FILE_TYPES[extensionOf(path)];

const utf8 = new TextDecoder("utf-8", { fatal: true });

/** Whether the content matches the type its extension claims: magic bytes for binaries, valid UTF-8 without NUL for text. */
export function contentMatches(path: string, data: Uint8Array): boolean {
  const ext = extensionOf(path);
  const type = FILE_TYPES[ext];
  if (!type) return false;
  if (type.text) {
    if (data.includes(0)) return false;
    try {
      utf8.decode(data);
      return true;
    } catch {
      return false;
    }
  }
  const signatures = MAGIC[ext];
  if (!signatures) return false;
  return signatures.some((sig) => sig.every((byte, i) => data[i] === byte));
}
