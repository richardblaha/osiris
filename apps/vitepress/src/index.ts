import { serve } from "@hono/node-server";
import { createVitepressApp } from "./app.ts";

const port = Number(process.env.PORT ?? 3003);
const server = serve({ fetch: createVitepressApp().fetch, port }, ({ port }) => console.log(`VitePress builder listening on http://localhost:${port}`));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
