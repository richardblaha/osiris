import { serve } from "@hono/node-server";
import { z } from "zod";
import { FsObjectStore, S3ObjectStore } from "@osiris/platform/objects.ts";
import { LocalDb, RqliteDb } from "@osiris/platform/rqlite.ts";
import { createSitesApp } from "./app.ts";

const env = z
  .object({
    PORT: z.coerce.number().int().default(8080),
    // rqlite with a read-only user; locally control's SQLite file.
    RQLITE_URL: z.url().optional(),
    RQLITE_USERNAME: z.string().optional(),
    RQLITE_PASSWORD: z.string().optional(),
    LOCAL_DB_PATH: z.string().default("../control/data/control.db"),
    S3_ENDPOINT: z.url().optional(),
    S3_REGION: z.string().default("fra1"),
    S3_BUCKET: z.string().optional(),
    S3_ACCESS_KEY_ID: z.string().optional(),
    S3_SECRET_ACCESS_KEY: z.string().optional(),
    LOCAL_OBJECTS_DIR: z.string().default("../control/data/objects"),
  })
  .parse(process.env);

const db = env.RQLITE_URL ? new RqliteDb(env.RQLITE_URL, { username: env.RQLITE_USERNAME, password: env.RQLITE_PASSWORD }) : new LocalDb(env.LOCAL_DB_PATH);
const objects = env.S3_BUCKET
  ? new S3ObjectStore({
      endpoint: env.S3_ENDPOINT!,
      region: env.S3_REGION,
      bucket: env.S3_BUCKET,
      accessKeyId: env.S3_ACCESS_KEY_ID!,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY!,
    })
  : new FsObjectStore(env.LOCAL_OBJECTS_DIR);

const server = serve({ fetch: createSitesApp({ db, objects }).fetch, port: env.PORT }, ({ port }) => console.log(`Sites listening on http://localhost:${port}`));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
