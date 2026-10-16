import { existsSync, readdirSync } from "node:fs";
import { serve } from "@hono/node-server";
import { createChatModel } from "./agent/model.ts";
import { loadSkills } from "./agent/skills.ts";
import { createApp } from "./app.ts";
import { createDevVerifier, createOidcVerifier } from "./auth/oidc.ts";
import { loadConfig, tenantDbProvider } from "./config.ts";
import { createEmbeddings } from "./rag/embeddings.ts";
import { SecretBox } from "./secrets.ts";
import { PocketIdClient } from "./pocketid.ts";
import { memoryTenants, pocketIdTenants } from "./tenants/directory.ts";
import { TenantRegistry } from "./tenants/registry.ts";
import { WhatsAppChannel } from "./whatsapp/channel.ts";
import { WhatsAppClient } from "./whatsapp/cloud-api.ts";
import { pocketIdDirectory } from "./whatsapp/directory.ts";

const config = loadConfig();

const bundledSkills = loadSkills(config.SKILLS_DIR);
if (bundledSkills.length) console.log(`Bundled skills: ${bundledSkills.map((s) => s.name).join(", ")}`);

if (!config.SECRETS_KEY) console.warn("SECRETS_KEY not set: MCP headers use an insecure development key.");
const secrets = config.SECRETS_KEY ? new SecretBox(config.SECRETS_KEY) : SecretBox.insecureDev();

// Tenant databases are opened (and created and migrated) lazily on a tenant's first request.
const tenants = new TenantRegistry(tenantDbProvider(config), {
  model: await createChatModel(config.LLM_MODEL),
  embeddings: createEmbeddings(config.EMBEDDING_MODEL),
  embeddingModel: config.EMBEDDING_MODEL,
  bundledSkills,
  timezone: config.TIMEZONE,
  secrets,
  mcp: { allowPrivate: config.MCP_ALLOW_PRIVATE },
});

if (config.AUTH_DEV_BYPASS) console.warn("AUTH_DEV_BYPASS is on: bearer tokens are trusted as user ids. Development only.");
const verifier = config.AUTH_DEV_BYPASS
  ? createDevVerifier()
  : createOidcVerifier(config.OIDC_ISSUER!, config.OIDC_AUDIENCE!);

const pocketId = config.POCKETID_API_KEY ? new PocketIdClient(config.OIDC_ISSUER!, config.POCKETID_API_KEY) : undefined;
if (!pocketId) console.warn("POCKETID_API_KEY not set: tenants are kept in memory (development only).");
// Without PocketID (development), the tenants are the database files already in TENANT_DATA_DIR.
const directory = pocketId
  ? pocketIdTenants(pocketId)
  : memoryTenants(
      existsSync(config.TENANT_DATA_DIR)
        ? readdirSync(config.TENANT_DATA_DIR).filter((f) => f.endsWith(".db")).map((f) => ({ id: f.slice(0, -3) }))
        : [],
    );

const whatsapp = config.WHATSAPP_ACCESS_TOKEN
  ? {
      channel: new WhatsAppChannel({
        tenants,
        directory,
        phones: pocketIdDirectory(pocketId!),
        client: new WhatsAppClient(config.WHATSAPP_ACCESS_TOKEN),
      }),
      verifyToken: config.WHATSAPP_VERIFY_TOKEN!,
      appSecret: config.WHATSAPP_APP_SECRET!,
    }
  : undefined;
if (!whatsapp) console.log("WhatsApp is not configured: /webhooks/whatsapp answers 404.");

const app = createApp({
  verifier,
  tenants,
  directory,
  corsOrigin: config.CORS_ORIGIN,
  // The web client's OIDC client ID is the API's token audience.
  web: config.STATIC_DIR
    ? { dir: config.STATIC_DIR, oidcAuthority: config.OIDC_ISSUER, oidcClientId: config.OIDC_AUDIENCE }
    : undefined,
  whatsapp,
});
serve({ fetch: app.fetch, port: config.PORT }, ({ port }) => console.log(`API listening on http://localhost:${port}`));
