import { serve } from "@hono/node-server";
import { InternalSigner } from "@osiris/platform/internal-auth.ts";
import { RuntimeClient } from "@osiris/platform/runtime-client.ts";
import { createGatewayApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { ControlDirectory } from "./control.ts";
import { createControlVerifier, createDevVerifier } from "./oidc.ts";

const config = loadConfig();
const signer = new InternalSigner(config.INTERNAL_JWT_PRIVATE_KEY, "gateway");
const control = new ControlDirectory(config.CONTROL_URL, signer);

if (config.AUTH_DEV_BYPASS) console.warn("AUTH_DEV_BYPASS is on: bearer tokens are trusted as user ids. Development only.");
const verifier = config.AUTH_DEV_BYPASS ? createDevVerifier() : createControlVerifier(control.identify);

const app = createGatewayApp({
  verifier,
  signer,
  control,
  controlUrl: config.CONTROL_URL,
  runtimes: new RuntimeClient(control),
  corsOrigin: config.CORS_ORIGIN,
  maxBodyBytes: config.MAX_BODY_MB * 1024 * 1024,
  limits: { requestsPerMinute: config.RATE_LIMIT_PER_MINUTE, runsPerMinute: config.RUN_LIMIT_PER_MINUTE },
  web: config.STATIC_DIR ? { dir: config.STATIC_DIR } : undefined,
});

const server = serve({ fetch: app.fetch, port: config.PORT }, ({ port }) => console.log(`Gateway listening on http://localhost:${port}`));
const shutdown = () => server.close(() => process.exit(0));
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
