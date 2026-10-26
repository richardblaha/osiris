import type { IncomingMessage, ServerResponse } from "node:http";
import { getRequestListener } from "@hono/node-server";
import type Provider from "oidc-provider";
import { blockList, clientIp } from "@osiris/platform/client-ip.ts";
import { OIDC_PATHS } from "./oidc.ts";

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v.join(",") : v);

/**
 * osiris-auth's HTTP handler: oidc-provider (a Koa app) answers its endpoints, Hono everything else. Both read the
 * client's address from X-Forwarded-For, so it is set here from the socket and only trusted proxies' headers
 * (attempt limits and the sign-in history count on it).
 */
export function authListener(app: { fetch: (req: Request) => Response | Promise<Response> }, provider: Provider, proxies: { trusted?: string; cdn?: string } = {}) {
  const hono = getRequestListener(app.fetch);
  const oidc = provider.callback();
  const trusted = blockList(proxies.trusted ?? "");
  const cdn = blockList(proxies.cdn ?? "");
  return (req: IncomingMessage, res: ServerResponse) => {
    const h = req.headers;
    const ip = clientIp(req.socket.remoteAddress ?? "", { realIp: one(h["x-real-ip"]), forwardedFor: one(h["x-forwarded-for"]), cdnClientIp: one(h["cf-connecting-ip"]) }, trusted, cdn);
    h["x-forwarded-for"] = ip || "unknown";
    return OIDC_PATHS.test(req.url ?? "/") ? oidc(req, res) : hono(req, res);
  };
}
