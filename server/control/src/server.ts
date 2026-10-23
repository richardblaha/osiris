import type { IncomingMessage, ServerResponse } from "node:http";
import { getRequestListener } from "@hono/node-server";
import type Provider from "oidc-provider";
import { OIDC_PATHS } from "./auth/oidc.ts";

/**
 * Control's HTTP handler: oidc-provider (a Koa app) answers its endpoints under `/auth`, Hono everything else. The
 * provider is given the path below its mount point and the full one as `originalUrl`, which it builds URLs from.
 */
export function controlListener(app: { fetch: (req: Request) => Response | Promise<Response> }, provider: Provider) {
  const hono = getRequestListener(app.fetch);
  const oidc = provider.callback();
  return (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "/";
    if (OIDC_PATHS.test(url)) {
      (req as IncomingMessage & { originalUrl?: string }).originalUrl = url;
      req.url = url.slice("/auth".length) || "/";
      return oidc(req, res);
    }
    return hono(req, res);
  };
}
