import { describe, expect, it, vi } from "vitest";
import { startEventPush } from "../src/events.ts";
import { memoryStateStore } from "../src/state.ts";

describe("the event push to Osiris's agent", () => {
  it("pushes only events at least minSeverity, rate-limited, as runs of the thread", async () => {
    const state = memoryStateStore();
    state.addEvent({ ts: "1", severity: "WARN", severity_number: "13", message: "slow", cluster: "c", pod: "p" });
    state.addEvent({ ts: "2", severity: "ERROR", severity_number: "17", message: "boom", cluster: "c", pod: "p", namespace: "ns" });
    const posts: { url: string; body: string; headers: Record<string, string> }[] = [];
    const fetchFn = vi.fn(async (url: unknown, init?: { body?: string; headers?: Record<string, string> }) => {
      posts.push({ url: String(url), body: String(init?.body), headers: init?.headers ?? {} });
      return new Response("{}", { status: 200 });
    });
    let slept = 0;
    const stop = startEventPush({
      state,
      url: "http://gateway",
      project: "osiris",
      thread: "t1",
      token: "tok",
      minSeverity: "error",
      maxPerMinute: 1,
      fetchFn: fetchFn as unknown as typeof fetch,
      sleep: async () => {
        slept++;
        if (slept > 3) stop();
      },
    });
    await vi.waitFor(() => expect(posts.length).toBe(1));
    stop();
    expect(posts[0]!.url).toBe("http://gateway/api/threads/t1/runs");
    expect(JSON.parse(posts[0]!.body)).toEqual({ message: "Událost z dvojčete (error, c / ns / p): boom" });
    expect(posts[0]!.headers).toMatchObject({ authorization: "Bearer tok", "x-project-id": "osiris" });
    // The warn stayed: below minSeverity. The second error was rate-limited out (maxPerMinute 1).
    state.addEvent({ ts: "3", severity: "ERROR", severity_number: "17", message: "again", cluster: "c" });
  });
});
