/** What the event is enriched with: the browser, OS and device from the User-Agent, bots, and where the visit came from. */

const BOT =
  /bot\b|bot\/|crawl|spider|slurp|scrap|facebookexternalhit|embedly|preview|headless|lighthouse|pagespeed|pingdom|uptime|monitor|python|curl|wget|httpclient|axios|okhttp|go-http|java\/|node-fetch|undici|phantom|selenium|puppeteer|playwright/i;

/** A crawler, a monitoring check or a script rather than a person (or no User-Agent at all). */
export const isBot = (userAgent: string) => !userAgent.trim() || BOT.test(userAgent);

export { parseUserAgent } from "@osiris/platform/user-agent.ts";

const SEARCH =
  /(^|\.)(google\.[a-z.]+|bing\.com|duckduckgo\.com|search\.yahoo\.com|yandex\.[a-z]+|seznam\.cz|search\.seznam\.cz|ecosia\.org|search\.brave\.com|qwant\.com|startpage\.com|baidu\.com)$/;
const SOCIAL =
  /(^|\.)(facebook\.com|fb\.me|instagram\.com|t\.co|twitter\.com|x\.com|linkedin\.com|lnkd\.in|youtube\.com|youtu\.be|reddit\.com|tiktok\.com|pinterest\.[a-z.]+|threads\.net|mastodon\.social|bsky\.app|whatsapp\.com|telegram\.org)$/;

const UTM = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"] as const;
export type Utm = Record<(typeof UTM)[number], string>;

export const utmOf = (url: URL): Utm => Object.fromEntries(UTM.map((k) => [k, (url.searchParams.get(k) ?? "").slice(0, 200)])) as Utm;

/**
 * The referring domain (without www.) and its kind: search, social, email (a campaign link from an e-mail), referral or
 * direct. Navigation within the site itself (`hosts`) counts as direct.
 */
export function referrerOf(referrer: string, hosts: string[], utm: Utm): { referrer_domain: string; referrer_source: string } {
  let host = "";
  try {
    if (referrer) host = new URL(referrer).hostname.toLowerCase();
  } catch {
    // Not a URL: as if there were none.
  }
  if (!host || hosts.includes(host)) {
    return { referrer_domain: "", referrer_source: utm.utm_medium.toLowerCase() === "email" ? "email" : "direct" };
  }
  const domain = host.replace(/^www\./, "");
  const source = SEARCH.test(host) ? "search" : SOCIAL.test(host) ? "social" : "referral";
  return { referrer_domain: domain, referrer_source: source };
}
