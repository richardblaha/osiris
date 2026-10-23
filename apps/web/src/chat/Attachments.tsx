import { createContext, useContext, useRef, useState, useEffect } from "react";
import { useAui, useAuiState } from "@assistant-ui/react";
import { t } from "i18next";

export const UploadContext = createContext<((file: File) => Promise<string>) | undefined>(undefined);
export function Attachments() {
  const upload = useContext(UploadContext);
  const [paths, setPaths] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [recording, setRecording] = useState(false);
  const recorder = useRef<MediaRecorder | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const recordTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => {
    clearTimeout(recordTimer.current);
    const media = recorder.current;
    if (media) { media.onstop = null; if (media.state === "recording") media.stop(); media.stream.getTracks().forEach(track => track.stop()); }
  }, []);
  const aui = useAui();
  const running = useAuiState(s => s.thread.isRunning);
  const add = async (files: File[]) => {
    if (!upload || !files.length) return;
    setBusy(true); setError(undefined);
    try {
      if (paths.length + files.length > 5) throw new Error(t("chat:tooManyAttachments", { count: 5 }));
      for (const file of files) {
        if (file.size > 20 * 1024 * 1024) throw new Error(t("chat:attachmentTooLarge", { mb: 20 }));
        const path = await upload(file);
        setPaths(current => [...current, path]);
      }
    } catch (err) { setError(err instanceof Error ? err.message : t("chat:uploadFailed")); }
    finally { setBusy(false); }
  };
  const record = async () => {
    if (recording) { recorder.current?.stop(); return; }
    setError(undefined);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = ["audio/webm", "audio/ogg", "audio/mp4"].find(type => MediaRecorder.isTypeSupported(type));
      let media: MediaRecorder;
      try { media = new MediaRecorder(stream, mimeType ? { mimeType } : undefined); }
      catch (err) { stream.getTracks().forEach(track => track.stop()); throw err; }
      recorder.current = media;
      const chunks: BlobPart[] = [];
      let size = 0;
      media.ondataavailable = e => { chunks.push(e.data); size += e.data.size; if (size > 20 * 1024 * 1024 && media.state === "recording") media.stop(); };
      media.onstop = () => {
        clearTimeout(recordTimer.current);
        stream.getTracks().forEach(track => track.stop()); setRecording(false);
        const ext = media.mimeType.includes("ogg") ? "ogg" : media.mimeType.includes("mp4") ? "m4a" : "webm";
        void add([new File(chunks, `${t("chat:voiceFile")}.${ext}`, { type: media.mimeType })]);
      };
      media.start(1000); setRecording(true);
      recordTimer.current = setTimeout(() => { if (media.state === "recording") media.stop(); }, 5 * 60_000);
    } catch (err) { setError(err instanceof Error ? err.message : t("chat:noMicrophone")); }
  };
  if (!upload) return null;
  return <div className="space-y-2 px-3 pb-2 text-xs">
    <div className="flex flex-wrap items-center gap-3">
      <button type="button" className="btn-link" disabled={busy || running || recording} onClick={() => input.current?.click()}>{busy ? t("chat:uploading") : t("chat:attach")}</button>
      {typeof MediaRecorder !== "undefined" && <button type="button" className={recording ? "btn-danger" : "btn-link"} disabled={busy || running} onClick={() => void record()}>{recording ? t("chat:stopRecording") : t("chat:voice")}</button>}
      {!!paths.length && <><span>{t("chat:attachments", { count: paths.length })}</span><button type="button" className="btn-link" disabled={busy || running} onClick={() => {
        const text = aui.composer().getState().text || t("chat:lookAtAttachments");
        aui.thread().append({ role: "user", content: [{ type: "text", text: `@osiris-attachments:${JSON.stringify({ text, paths })}` }] });
        aui.composer().setText(""); setPaths([]);
      }}>{t("chat:sendAttachments")}</button><button type="button" className="btn-link" onClick={() => setPaths([])}>{t("chat:removeAttachments")}</button></>}
    </div>
    <input ref={input} type="file" multiple hidden accept="image/png,image/jpeg,image/webp,image/gif,application/pdf,text/plain,text/csv,.md,.docx,.xlsx,.ogg,.mp3,.wav,.webm,.m4a" onChange={e => { void add(Array.from(e.target.files ?? [])); e.target.value = ""; }} />
    {error && <p className="text-error">{error}</p>}
  </div>;
}
