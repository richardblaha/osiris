import { Box, Text, useApp, useInput, useWindowSize } from "ink";
import { useEffect, useState } from "react";
import { api, setProject } from "@osiris/client/api.ts";
import type { MeResponse, ProjectInfo, ProjectUsage, ThreadSummary } from "@osiris/shared";
import { Chat } from "./Chat.tsx";
import { text } from "./text.ts";
import type { ThemeColors } from "./theme.ts";

type Context = "knowledge" | "memory" | "files" | "skills";
const CONTEXTS: Context[] = ["knowledge", "memory", "files", "skills"];
type Pane = "sidebar" | "chat" | "detail";

/** What the sidebar lists, top to bottom, as the PWA's: a new chat, the conversations, then the context. */
type Item = { kind: "new" } | { kind: "thread"; thread: ThreadSummary } | { kind: "context"; context: Context };

const SIDEBAR = 30;
/** Tokens in thousands, as the PWA's meters show them. */
const thousands = (n: number) => `${Math.round(n / 100) / 10} ${text.thousand}`;
const DETAIL = 42;

/** Bytes as a short size (kB, MB, GB). */
const size = (n: number) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} kB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(1)} GB`);

/**
 * Osiris in the terminal, laid out like the PWA and narrowing with the terminal: sidebar | chat | detail from 120
 * columns, sidebar | chat from 80, one pane at a time below (Tab switches).
 */
export function App({ theme, projectId }: { theme: ThemeColors; projectId?: string }) {
  const { exit } = useApp();
  const { columns, rows } = useWindowSize();
  const [me, setMe] = useState<MeResponse>();
  const [project, setProjectInfo] = useState<ProjectInfo>();
  const [usage, setUsage] = useState<ProjectUsage>();
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [threadId, setThreadId] = useState<string>();
  const [context, setContext] = useState<Context>();
  const [pane, setPane] = useState<Pane>("chat");
  const [cursor, setCursor] = useState(0);
  const [error, setError] = useState<string>();

  const layout = columns >= 120 ? "wide" : columns >= 80 ? "medium" : "narrow";

  const loadThreads = () => api.threads().then(setThreads, () => {});
  useEffect(() => {
    void (async () => {
      const who = await api.me();
      setMe(who);
      const chosen = who.projects.find((p) => p.id === projectId) ?? who.projects[0];
      if (!chosen) throw new Error("No project");
      setProject(chosen.id);
      setProjectInfo(await api.project());
      await loadThreads();
      setUsage(await api.usage().catch(() => undefined));
    })().catch((e: Error) => setError(e.message));
  }, []);

  const on = project?.features;
  const items: Item[] = [
    { kind: "new" },
    ...threads.map((thread): Item => ({ kind: "thread", thread })),
    ...CONTEXTS.filter((c) => !on || on[c === "knowledge" ? "knowledge" : c]).map((context): Item => ({ kind: "context", context })),
  ];

  const open = (item: Item) => {
    if (item.kind === "new") (setThreadId(undefined), setContext(undefined), setPane("chat"));
    else if (item.kind === "thread") (setThreadId(item.thread.id), setContext(undefined), setPane("chat"));
    else (setContext(item.context), setPane(layout === "wide" ? "sidebar" : "detail"));
  };

  useInput((input, key) => {
    if (key.ctrl && input === "c") exit();
    if (key.ctrl && input === "n") open({ kind: "new" });
    if (key.tab) {
      // The detail beside a wide layout only shows; where a context list takes the chat's place, it's the other pane.
      const order: Pane[] = layout !== "wide" && context ? ["sidebar", "detail"] : ["sidebar", "chat"];
      setPane(order[(order.indexOf(pane) + (key.shift ? order.length - 1 : 1)) % order.length]!);
    }
    if (pane !== "sidebar") return;
    if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
    if (key.downArrow) setCursor((c) => Math.min(items.length - 1, c + 1));
    if (key.return && items[cursor]) open(items[cursor]!);
  });

  if (error) return <Text color={theme.stateError}>Osiris: {error}</Text>;
  if (!me || !project) return <Text color={theme.textMuted}>{text.loading}</Text>;

  const bodyRows = rows - 2;
  const chatWidth = layout === "wide" ? columns - SIDEBAR - DETAIL : layout === "medium" ? columns - SIDEBAR : columns;
  const sidebar = (
    <Sidebar
      key="sidebar"
      theme={theme}
      items={items}
      cursor={cursor}
      focused={pane === "sidebar"}
      threadId={threadId}
      context={context}
      width={layout === "narrow" ? columns : SIDEBAR}
      height={bodyRows}
    />
  );
  const chat = <Chat key="chat" threadId={threadId} onThread={(id) => (setThreadId(id), void loadThreads())} onDone={() => void (loadThreads(), api.usage().then(setUsage, () => {}))} theme={theme} focused={pane === "chat"} width={chatWidth} height={bodyRows} />;
  const detail = context ? <ContextList key={context} context={context} theme={theme} width={layout === "wide" ? DETAIL : chatWidth} height={bodyRows} /> : <ProjectPanel key="project" project={project} usage={usage} theme={theme} width={DETAIL} height={bodyRows} />;

  return (
    <Box flexDirection="column" width={columns} height={rows}>
      <Box height={bodyRows}>
        {layout === "narrow" ? (pane === "sidebar" ? sidebar : pane === "detail" && context ? detail : chat) : null}
        {layout === "medium" ? [sidebar, context && pane !== "chat" ? detail : chat] : null}
        {layout === "wide" ? [sidebar, chat, detail] : null}
      </Box>
      <StatusBar theme={theme} project={project} usage={usage} width={columns} narrow={layout === "narrow"} />
    </Box>
  );
}

function Sidebar({ theme, items, cursor, focused, threadId, context, width, height }: { theme: ThemeColors; items: Item[]; cursor: number; focused: boolean; threadId?: string; context?: Context; width: number; height: number }) {
  const firstContext = items.findIndex((i) => i.kind === "context");
  return (
    <Box flexDirection="column" width={width} height={height} borderStyle="single" borderTop={false} borderBottom={false} borderLeft={false} borderColor={theme.borderSubtle} paddingX={1}>
      <Text bold color={theme.accentPrimary}>
        {"◆ O S I R I S"}
      </Text>
      <Box height={1} />
      {items.map((item, i) => {
        const selected = focused && i === cursor;
        const active = (item.kind === "thread" && item.thread.id === threadId && !context) || (item.kind === "context" && item.context === context);
        const label = item.kind === "new" ? text.newChat : item.kind === "thread" ? item.thread.title || "…" : text[item.context];
        return (
          <Box key={i} flexDirection="column">
            {i === 1 && item.kind === "thread" && <Text color={theme.textMuted}>{text.conversations}</Text>}
            {i === firstContext && (
              <Box marginTop={1}>
                <Text color={theme.textMuted}>{text.context}</Text>
              </Box>
            )}
            <Text
              wrap="truncate-end"
              color={item.kind === "new" ? theme.accentPrimary : active ? theme.accentPrimary : theme.textPrimary}
              backgroundColor={selected ? theme.bgSelection : undefined}
              bold={item.kind === "new" || active}
            >
              {selected ? "› " : "  "}
              {item.kind === "context" ? label.toUpperCase() : label}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}

/** One part of the context, read-only (editing is the PWA's). */
function ContextList({ context, theme, width, height }: { context: Context; theme: ThemeColors; width: number; height: number }) {
  const [lines, setLines] = useState<{ text: string; hint?: string }[]>();
  useEffect(() => {
    const load = {
      knowledge: async () => (await api.documents()).map((d) => ({ text: d.title, hint: d.scope === "personal" ? text.personal : d.id })),
      memory: async () => (await api.memories()).map((m) => ({ text: m.content, hint: m.scope === "personal" ? text.personal : undefined })),
      files: async () => (await api.files("project")).map((f) => ({ text: f.type === "dir" ? `${f.name}/` : f.name, hint: f.type === "file" ? size(f.size) : undefined })),
      skills: async () => (await api.skills()).filter((s) => !s.overridden).map((s) => ({ text: s.name, hint: s.description })),
    }[context];
    void load().then(setLines, (e: Error) => setLines([{ text: e.message }]));
  }, [context]);
  return (
    <Box flexDirection="column" width={width} height={height} paddingX={1} overflow="hidden">
      <Text bold color={theme.accentPrimary}>
        {text[context].toUpperCase()}
      </Text>
      <Text color={theme.textMuted}>{text.readOnly}</Text>
      <Box height={1} />
      {!lines ? <Text color={theme.textMuted}>{text.loading}</Text> : !lines.length ? <Text color={theme.textMuted}>{text.none}</Text> : null}
      {lines?.slice(0, Math.max(0, height - 4)).map((l, i) => (
        <Text key={i} wrap="truncate-end" color={theme.textPrimary}>
          {l.text}
          {l.hint ? <Text color={theme.textMuted}> · {l.hint}</Text> : null}
        </Text>
      ))}
    </Box>
  );
}

function ProjectPanel({ project, usage, theme, width, height }: { project: ProjectInfo; usage?: ProjectUsage; theme: ThemeColors; width: number; height: number }) {
  return (
    <Box flexDirection="column" width={width} height={height} paddingX={1} borderStyle="single" borderTop={false} borderBottom={false} borderRight={false} borderColor={theme.borderSubtle}>
      <Text bold color={theme.textPrimary}>
        {project.name}
      </Text>
      <Text color={theme.textSecondary}>{text.role[project.role]}</Text>
      {usage && (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.textMuted}>
            {text.storage}: {size(usage.storage.used)}
            {usage.storage.limit ? ` / ${size(usage.storage.limit)}` : ""}
          </Text>
          <Text color={theme.textMuted}>
            {text.ai}: {thousands(usage.tokens.used)}
          </Text>
        </Box>
      )}
    </Box>
  );
}

function StatusBar({ theme, project, usage, width, narrow }: { theme: ThemeColors; project: ProjectInfo; usage?: ProjectUsage; width: number; narrow: boolean }) {
  return (
    <Box width={width} height={2} flexDirection="column">
      <Box justifyContent="space-between" paddingX={1}>
        <Text color={theme.textPrimary} wrap="truncate-end">
          {project.name} · {text.role[project.role]}
        </Text>
        {usage && !narrow && (
          <Text color={theme.textSecondary}>
            {text.storage} {size(usage.storage.used)} · {text.ai} {thousands(usage.tokens.used)}
          </Text>
        )}
      </Box>
      <Text color={theme.textMuted} wrap="truncate-end">
        {" "}
        {narrow ? text.keysNarrow : text.keys}
      </Text>
    </Box>
  );
}
