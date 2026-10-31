import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { BlockList } from "node:net";
import { runInNewContext } from "node:vm";
import { clientIp, createWebEventsApp, type Outcome } from "../src/app.ts";
import { isBot, parseUserAgent, referrerOf, utmOf } from "../src/enrich.ts";
import { VisitorHasher } from "../src/visitor.ts";

const SEED = "x".repeat(32);
const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const SCRIPT = readFileSync(new URL("../src/e.js", import.meta.url), "utf8");

describe("visitor hash", () => {
  it("is the same within a day, different the next day and per site, IP and browser", () => {
    let now = new Date("2026-10-22T08:00:00Z");
    const hasher = new VisitorHasher(SEED, () => now);
    const a = hasher.hash("k6labs.cz", "203.0.113.5", CHROME);
    expect(a).toMatch(/^\d+$/);
    expect(BigInt(a) < 2n ** 64n).toBe(true);
    expect(hasher.hash("k6labs.cz", "203.0.113.5", CHROME)).toBe(a);
    expect(hasher.hash("tras.cz", "203.0.113.5", CHROME)).not.toBe(a);
    expect(hasher.hash("k6labs.cz", "203.0.113.6", CHROME)).not.toBe(a);
    expect(hasher.hash("k6labs.cz", "203.0.113.5", IPHONE)).not.toBe(a);
    now = new Date("2026-10-23T08:00:00Z");
    expect(hasher.hash("k6labs.cz", "203.0.113.5", CHROME)).not.toBe(a);
    // Another replica with the same seed agrees.
    expect(new VisitorHasher(SEED, () => now).hash("k6labs.cz", "203.0.113.5", CHROME)).toBe(hasher.hash("k6labs.cz", "203.0.113.5", CHROME));
    expect(() => new VisitorHasher("short")).toThrow();
  });
});

describe("enrichment", () => {
  it("parses browsers, systems and devices", () => {
    expect(parseUserAgent(CHROME, 1920)).toEqual({ browser: "Chrome", os: "Windows", device: "desktop" });
    expect(parseUserAgent(IPHONE, 390)).toEqual({ browser: "Safari", os: "iOS", device: "mobile" });
    expect(parseUserAgent("Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0", 1440)).toMatchObject({ browser: "Firefox", os: "Linux" });
    expect(parseUserAgent(`${CHROME} Edg/141.0.0.0`, 1920).browser).toBe("Edge");
    expect(parseUserAgent("Mozilla/5.0 (Linux; Android 14; SM-X910) AppleWebKit/537.36 Chrome/141.0 Safari/537.36", 1200)).toMatchObject({ os: "Android", device: "tablet" });
    expect(parseUserAgent(CHROME, 400).device).toBe("mobile");
  });

  it("knows bots", () => {
    expect(isBot("Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)")).toBe(true);
    expect(isBot("Mozilla/5.0 ... HeadlessChrome/120.0")).toBe(true);
    expect(isBot("curl/8.5.0")).toBe(true);
    expect(isBot("")).toBe(true);
    expect(isBot(CHROME)).toBe(false);
  });

  it("sorts referrers and reads UTM parameters", () => {
    const none = utmOf(new URL("https://k6labs.cz/"));
    const hosts = ["k6labs.cz", "www.k6labs.cz"];
    expect(referrerOf("https://www.google.cz/", hosts, none)).toEqual({ referrer_domain: "google.cz", referrer_source: "search" });
    expect(referrerOf("https://search.seznam.cz/?q=x", hosts, none)).toEqual({ referrer_domain: "search.seznam.cz", referrer_source: "search" });
    expect(referrerOf("https://l.facebook.com/l.php", hosts, none)).toEqual({ referrer_domain: "l.facebook.com", referrer_source: "social" });
    expect(referrerOf("https://blog.example.org/post", hosts, none)).toEqual({ referrer_domain: "blog.example.org", referrer_source: "referral" });
    expect(referrerOf("https://www.k6labs.cz/en/", hosts, none)).toEqual({ referrer_domain: "", referrer_source: "direct" });
    expect(referrerOf("", hosts, none)).toEqual({ referrer_domain: "", referrer_source: "direct" });
    const utm = utmOf(new URL("https://k6labs.cz/?utm_source=newsletter&utm_medium=email&utm_campaign=rijen"));
    expect(utm).toMatchObject({ utm_source: "newsletter", utm_medium: "email", utm_campaign: "rijen", utm_term: "" });
    expect(referrerOf("", hosts, utm).referrer_source).toBe("email");
  });
});

describe("client IP", () => {
  const trusted = new BlockList();
  trusted.addSubnet("10.0.0.0", 8, "ipv4");
  it("believes the ingress's headers only from a trusted proxy", () => {
    expect(clientIp("10.42.1.7", { realIp: "203.0.113.5" }, trusted)).toBe("203.0.113.5");
    expect(clientIp("::ffff:10.42.1.7", { forwardedFor: "198.51.100.1, 203.0.113.5" }, trusted)).toBe("203.0.113.5");
    expect(clientIp("198.51.100.9", { realIp: "203.0.113.5" }, trusted)).toBe("198.51.100.9");
    expect(clientIp("10.42.1.7", { realIp: "nonsense" }, trusted)).toBe("10.42.1.7");
  });

  it("takes the visitor's IP from Cloudflare only when the connection came from Cloudflare", () => {
    const cdn = new BlockList();
    cdn.addSubnet("104.16.0.0", 13, "ipv4");
    expect(clientIp("10.42.1.7", { realIp: "104.23.199.10", cdnClientIp: "2a00:c500:235:d17::1001" }, trusted, cdn)).toBe("2a00:c500:235:d17::1001");
    // A visitor faking the header on a site not behind Cloudflare.
    expect(clientIp("10.42.1.7", { realIp: "203.0.113.5", cdnClientIp: "198.51.100.1" }, trusted, cdn)).toBe("203.0.113.5");
    expect(clientIp("10.42.1.7", { realIp: "104.23.199.10", cdnClientIp: "garbage" }, trusted, cdn)).toBe("104.23.199.10");
  });
});

describe("POST /_e", () => {
  const setup = () => {
    const emitted: { event: string; attributes: Record<string, string> }[] = [];
    const outcomes: Outcome[] = [];
    const trusted = new BlockList();
    trusted.addSubnet("10.0.0.0", 8, "ipv4");
    const app = createWebEventsApp({
      sites: [{ id: "k6labs.cz", hosts: ["k6labs.cz", "www.k6labs.cz"] }],
      hasher: new VisitorHasher(SEED),
      country: (ip) => (ip === "203.0.113.5" ? "CZ" : ""),
      geo: () => ({ country: "CZ", region: "Prague", city: "Prague", asn: "AS123", network: "Example ISP" }),
      emit: (event, attributes) => emitted.push({ event, attributes }),
      trustedProxies: trusted,
      cdnProxies: new BlockList(),
      script: SCRIPT,
      count: (o) => outcomes.push(o),
    });
    const post = (body: unknown, headers: Record<string, string> = {}) =>
      app.request(
        "/_e",
        { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: { host: "k6labs.cz", "user-agent": CHROME, "x-real-ip": "203.0.113.5", ...headers } },
        { incoming: { socket: { remoteAddress: "10.42.0.12" } } } as never,
      );
    return { app, post, emitted, outcomes };
  };
  const event = { s: "k6labs.cz", u: "https://k6labs.cz/cenik?utm_source=fb", r: "https://www.google.com/", w: 1920, l: "cs-CZ" };

  it("stores a pageview with what it's enriched with, but no IP", async () => {
    const { post, emitted } = await setup();
    expect((await post(event)).status).toBe(202);
    const [e] = emitted;
    expect(e!.event).toBe("pageview");
    expect(e!.attributes).toMatchObject({
      site: "k6labs.cz",
      event: "pageview",
      path: "/cenik",
      referrer_domain: "google.com",
      referrer_source: "search",
      utm_source: "fb",
      country: "CZ",
      region: "Prague", city: "Prague", asn: "AS123", network: "Example ISP",
      browser: "Chrome",
      os: "Windows",
      device: "desktop",
      screen: "1920",
      lang: "cs-cz",
    });
    expect(e!.attributes.visitor_hash).toMatch(/^\d+$/);
    expect(JSON.stringify(emitted)).not.toContain("203.0.113.5");
  });

  it("takes custom events with props", async () => {
    const { post, emitted } = await setup();
    expect((await post({ ...event, e: "signup", p: { plan: "pro", seats: 3 } })).status).toBe(202);
    expect(emitted[0]!.attributes).toMatchObject({ event: "signup", "prop.plan": "pro", "prop.seats": "3" });
  });

  it("refuses unknown sites, other hosts, bad payloads and big bodies; drops bots and Do Not Track quietly", async () => {
    const { post, emitted, outcomes } = await setup();
    expect((await post({ ...event, s: "evil.example" })).status).toBe(403);
    expect((await post({ ...event, u: "https://evil.example/" })).status).toBe(403);
    expect((await post(event, { host: "tras.cz" })).status).toBe(403);
    expect((await post("{not json")).status).toBe(400);
    expect((await post({ ...event, e: "<script>" })).status).toBe(400);
    expect((await post({ ...event, p: Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`k${i}`, "v"])) })).status).toBe(400);
    expect((await post({ ...event, r: "x".repeat(5000) })).status).toBe(413);
    expect((await post(event, { "user-agent": "Googlebot/2.1" })).status).toBe(204);
    expect((await post(event, { dnt: "1" })).status).toBe(204);
    expect(emitted).toHaveLength(0);
    expect(outcomes).toEqual(["forbidden", "forbidden", "forbidden", "invalid", "invalid", "invalid", "too_large", "bot", "dnt"]);
  });

  it("serves the script, cached", async () => {
    const res = await (await setup()).app.request("/_e/e.js");
    expect(res.headers.get("content-type")).toContain("javascript");
    expect(res.headers.get("cache-control")).toContain("max-age");
    expect(await res.text()).toBe(SCRIPT);
  });
});

describe("e.js", () => {
  /** Runs the script in a minimal browser: what it sends, and its history hooks. */
  const browser = ({ host = "k6labs.cz", dnt = "0", site = "k6labs.cz", manual = false, queued = [] as string[] } = {}) => {
    const sent: Record<string, unknown>[] = [];
    const listeners: Record<string, () => void> = {};
    const location = { href: `https://${host}/`, origin: `https://${host}`, pathname: "/", hostname: host, protocol: "https:" };
    const history = {
      pushState(_: unknown, __: string, url: string) {
        location.pathname = url;
        location.href = `https://${host}${url}`;
      },
      replaceState(_: unknown, __: string, url: string) {
        location.pathname = url;
        location.href = `https://${host}${url}`;
      },
    };
    const window: Record<string, unknown> = { addEventListener: (k: string, f: () => void) => (listeners[k] = f), ...(queued.length ? { waq: [...queued] } : {}) };
    runInNewContext(SCRIPT, {
      window,
      document: { currentScript: { getAttribute: (k: string) => (k === "data-site" ? site : k === "data-manual" && manual ? "" : null) }, referrer: "https://www.google.com/" },
      navigator: { doNotTrack: dnt, language: "cs", sendBeacon: (_: string, blob: { text: string }) => (sent.push(JSON.parse(blob.text)), true) },
      location,
      history,
      screen: { width: 1280 },
      Blob: class {
        text: string;
        constructor(parts: string[]) {
          this.text = parts.join("");
        }
      },
      fetch: () => Promise.resolve(),
    });
    return { sent, history, window, listeners };
  };

  it("sends the first pageview with the referrer, SPA navigations without, and skips repeats", () => {
    const { sent, history, window } = browser();
    history.pushState(null, "", "/cenik");
    history.replaceState(null, "", "/cenik");
    history.pushState(null, "", "/kontakt");
    (window.wa as { event: (n: string, p: object) => void }).event("signup", { plan: "pro" });
    expect(sent.map((e) => [e.e, e.u, e.r])).toEqual([
      ["pageview", "https://k6labs.cz/", "https://www.google.com/"],
      ["pageview", "https://k6labs.cz/cenik", ""],
      ["pageview", "https://k6labs.cz/kontakt", ""],
      ["signup", "https://k6labs.cz/kontakt", ""],
    ]);
    expect(sent[3]).toMatchObject({ s: "k6labs.cz", w: 1280, l: "cs", p: { plan: "pro" } });
  });

  it("counts only the paths an app names with data-manual, never its own URL, and sends what waited", () => {
    const { sent, history, window, listeners } = browser({ host: "osiris.k6labs.cz", site: "osiris.k6labs.cz", manual: true, queued: ["/chat"] });
    history.pushState(null, "", "/chat/thread-123?code=secret");
    const wa = window.wa as { pageview: (p: string) => void; event: (n: string) => void };
    wa.pageview("/chat");
    wa.pageview("/files");
    wa.event("upload");
    expect(sent.map((e) => [e.e, e.u])).toEqual([
      ["pageview", "https://osiris.k6labs.cz/chat"],
      ["pageview", "https://osiris.k6labs.cz/files"],
      ["upload", "https://osiris.k6labs.cz/files"],
    ]);
    expect(window.waq).toBeUndefined();
    expect(listeners.popstate).toBeUndefined();
  });

  it("stays silent with Do Not Track, on localhost and without data-site", () => {
    expect(browser({ dnt: "1" }).sent).toEqual([]);
    expect(browser({ host: "localhost" }).sent).toEqual([]);
    expect(browser({ site: "" }).sent).toEqual([]);
  });
});
