import { createContext, useContext, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ComposerPrimitive, ThreadPrimitive, useAui, useAuiState } from "@assistant-ui/react";
import { t } from "i18next";

/** Uploads a file to the open thread's scratchpad and gives its path; absent on the public chat (no uploads). */
export const UploadContext = createContext<((file: File) => Promise<string>) | undefined>(undefined);

const MAX_FILES = 5;
const MAX_MB = 20;
const MAX_RECORDING_MS = 5 * 60_000;

const Icon = ({ d, className = "h-5 w-5" }: { d: string; className?: string }) => (
  <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
    <path d={d} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const PAPERCLIP = "M21.4 11.1l-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5";
const MIC = "M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3zM19 10v2a7 7 0 0 1-14 0v-2M12 19v3";
const SEND = "M12 19V5M5 12l7-7 7 7";
const CLOSE = "M6 6l12 12M18 6L6 18";

const clock = (ms: number) => `${Math.floor(ms / 60_000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;
const fileName = (path: string) => path.replace(/^[0-9a-f-]{36}-/, "");

/**
 * The message box: text, attached files (sent with the text, by the send button or Enter) and a voice message, which
 * is sent as soon as the recording stops (the server transcribes it).
 */
export function Composer({ placeholder }: { placeholder: string }) {
  const upload = useContext(UploadContext);
  const aui = useAui();
  const running = useAuiState((s) => s.thread.isRunning);
  const [paths, setPaths] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [recordingSince, setRecordingSince] = useState<number>();
  const [now, setNow] = useState(Date.now());
  const recorder = useRef<MediaRecorder | null>(null);
  // Stopping by cancel throws the recording away.
  const discard = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const recording = recordingSince !== undefined;

  useEffect(() => () => {
    const media = recorder.current;
    if (!media) return;
    media.onstop = null;
    if (media.state === "recording") media.stop();
    media.stream.getTracks().forEach((track) => track.stop());
  }, []);
  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [recording]);

  const uploadAll = async (files: File[], already: number) => {
    if (already + files.length > MAX_FILES) throw new Error(t("chat:tooManyAttachments", { count: MAX_FILES }));
    const done: string[] = [];
    for (const file of files) {
      if (file.size > MAX_MB * 1024 * 1024) throw new Error(t("chat:attachmentTooLarge", { mb: MAX_MB }));
      done.push(await upload!(file));
    }
    return done;
  };
  const attach = async (files: File[]) => {
    if (!upload || !files.length) return;
    setBusy(true);
    setError(undefined);
    try {
      const added = await uploadAll(files, paths.length);
      setPaths((current) => [...current, ...added]);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("chat:uploadFailed"));
    } finally {
      setBusy(false);
    }
  };

  /** Sends the text with the attached files and the recorded message (`voice`, transcribed as the user's words) as one message. */
  const sendWith = (files: string[], voice?: string) => {
    const typed = aui.composer().getState().text.trim();
    const text = typed || (voice ? "" : t("chat:lookAtAttachments"));
    aui.thread().append({ role: "user", content: [{ type: "text", text: `@osiris-attachments:${JSON.stringify({ text, paths: files, ...(voice ? { voice } : {}) })}` }] });
    aui.composer().setText("");
    setPaths([]);
  };

  const startRecording = async () => {
    setError(undefined);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = ["audio/webm", "audio/ogg", "audio/mp4"].find((type) => MediaRecorder.isTypeSupported(type));
      let media: MediaRecorder;
      try {
        media = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      } catch (err) {
        stream.getTracks().forEach((track) => track.stop());
        throw err;
      }
      recorder.current = media;
      discard.current = false;
      const chunks: BlobPart[] = [];
      let size = 0;
      const limit = setTimeout(() => media.state === "recording" && media.stop(), MAX_RECORDING_MS);
      media.ondataavailable = (e) => {
        chunks.push(e.data);
        size += e.data.size;
        if (size > MAX_MB * 1024 * 1024 && media.state === "recording") media.stop();
      };
      media.onstop = () => {
        clearTimeout(limit);
        stream.getTracks().forEach((track) => track.stop());
        setRecordingSince(undefined);
        if (discard.current || !size) return;
        const ext = media.mimeType.includes("ogg") ? "ogg" : media.mimeType.includes("mp4") ? "m4a" : "webm";
        const file = new File(chunks, `${t("chat:voiceFile")}.${ext}`, { type: media.mimeType });
        setBusy(true);
        uploadAll([file], paths.length)
          .then(([voice]) => sendWith([...paths, voice!], voice))
          .catch((err: unknown) => setError(err instanceof Error ? err.message : t("chat:uploadFailed")))
          .finally(() => setBusy(false));
      };
      media.start(1000);
      setNow(Date.now());
      setRecordingSince(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : t("chat:noMicrophone"));
    }
  };
  const stopRecording = (keep: boolean) => {
    discard.current = !keep;
    recorder.current?.stop();
  };

  // With files attached, Enter sends them along instead of the plain text.
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing || !paths.length) return;
    e.preventDefault();
    if (!running && !busy) sendWith(paths);
  };

  const canVoice = !!upload && typeof MediaRecorder !== "undefined";
  return (
    <ComposerPrimitive.Root className="composer relative rounded-md border border-line-strong bg-input shadow-lg transition-[border-color,box-shadow] focus-within:border-primary focus-within:shadow-[0_0_0_3px_var(--accent-primary-soft)]">
      <ComposerPrimitive.Input
        autoFocus
        placeholder={placeholder}
        minRows={3}
        maxRows={12}
        onKeyDown={onKeyDown}
        className="block w-full resize-none bg-transparent px-4 pt-3 pb-14 outline-none"
      />
      <div className="absolute inset-x-2 bottom-2 flex items-end gap-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 text-xs">
          {upload && (
            <button
              type="button"
              className="icon-button btn-ghost"
              disabled={busy || running || recording}
              onClick={() => input.current?.click()}
              aria-label={t("chat:attach")}
              title={t("chat:attach")}
            >
              {busy && !recording ? <span className="tool-spinner" /> : <Icon d={PAPERCLIP} />}
            </button>
          )}
          {paths.map((p) => (
            <span key={p} className="badge flex max-w-48 items-center gap-1">
              <span className="truncate">{fileName(p)}</span>
              <button type="button" className="text-fg-muted hover:text-fg" onClick={() => setPaths((current) => current.filter((x) => x !== p))} aria-label={t("chat:removeAttachment", { name: fileName(p) })}>
                <Icon d={CLOSE} className="h-3 w-3" />
              </button>
            </span>
          ))}
          {recording && (
            <span className="flex items-center gap-1.5 text-error" role="status">
              <span className="h-2 w-2 animate-pulse rounded-full bg-error" aria-hidden="true" />
              {t("chat:recording", { time: clock(now - recordingSince) })}
            </span>
          )}
          {error && <span className="text-error">{error}</span>}
        </div>
        {recording && (
          <button type="button" className="icon-button btn-secondary" onClick={() => stopRecording(false)} aria-label={t("chat:cancelRecording")} title={t("chat:cancelRecording")}>
            <Icon d={CLOSE} className="h-4 w-4" />
          </button>
        )}
        {canVoice && (
          <button
            type="button"
            className={`icon-button ${recording ? "btn-recording" : "btn-secondary"}`}
            disabled={(busy && !recording) || running}
            onClick={() => (recording ? stopRecording(true) : void startRecording())}
            aria-label={recording ? t("chat:stopAndSend") : t("chat:voice")}
            title={recording ? t("chat:stopAndSend") : t("chat:voiceHint")}
            aria-pressed={recording}
          >
            <Icon d={MIC} />
          </button>
        )}
        <ThreadPrimitive.If running={false}>
          {paths.length ? (
            <button type="button" className="icon-button btn-primary" disabled={busy || recording} onClick={() => sendWith(paths)} aria-label={t("chat:send")} title={t("chat:sendHint")}>
              <Icon d={SEND} />
            </button>
          ) : (
            <ComposerPrimitive.Send className="icon-button btn-primary" disabled={recording} aria-label={t("chat:send")} title={t("chat:sendHint")}>
              <Icon d={SEND} />
            </ComposerPrimitive.Send>
          )}
        </ThreadPrimitive.If>
        <ThreadPrimitive.If running>
          <ComposerPrimitive.Cancel className="icon-button btn-secondary" aria-label={t("chat:stop")} title={t("chat:stop")}>
            <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
              <rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" />
            </svg>
          </ComposerPrimitive.Cancel>
        </ThreadPrimitive.If>
      </div>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        accept="image/png,image/jpeg,image/webp,image/gif,application/pdf,text/plain,text/csv,.md,.docx,.xlsx,.ogg,.mp3,.wav,.webm,.m4a"
        onChange={(e) => {
          void attach(Array.from(e.target.files ?? []));
          e.target.value = "";
        }}
      />
    </ComposerPrimitive.Root>
  );
}
