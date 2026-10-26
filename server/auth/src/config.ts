import { z } from "zod";

const pem = z.string().transform((v) => v.replace(/\\n/g, "\n"));
const url = z.url().transform((v) => v.replace(/\/$/, ""));
const list = z
  .string()
  .default("")
  .transform((v) => v.split(",").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean));

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    PORT: z.coerce.number().int().default(3003),
    // The database (SQLite file) and profile pictures, on the service's volume.
    DATA_DIR: z.string().default("./data"),

    // Where browsers reach osiris-auth; also the OpenID Connect issuer.
    PUBLIC_URL: url.default("http://localhost:3003"),
    // The name users see (pages, emails, passkeys, authenticator apps), and an optional logo URL for the pages.
    APP_NAME: z.string().trim().min(1).max(60).default("Auth"),
    APP_LOGO_URL: z.url().optional(),
    // Members of this group administer the identity provider (/admin, SCIM from the browser).
    ADMIN_GROUP: z.string().regex(/^[a-z0-9][a-z0-9:._-]{0,99}$/).default("admin"),
    // Osiris's apps, registered at startup when missing (never changed afterwards; admins own them): osiris-web with
    // <origin>/callback for each of these origins (comma-separated), osiris-cli, osiris-vscode, and osiris-gateway
    // (introspects their tokens) with GATEWAY_CLIENT_SECRET. Empty = none.
    WEB_ORIGINS: list,
    // The passkeys' relying party: the host they were registered on. Kept `osiris.k6labs.cz` in production, so the
    // passkeys made there keep working (it lists this origin at /.well-known/webauthn). Default: PUBLIC_URL's host.
    PASSKEY_RP_ID: z.string().optional(),
    GATEWAY_CLIENT_SECRET: z.string().min(32).optional(),

    // Signs ID tokens: an EC P-256 private key (PEM). `pnpm --filter @osiris/platform gen-keys` makes one.
    AUTH_SIGNING_KEY: pem.optional(),
    // 32 bytes, base64: signs the provider's cookies and seals TOTP secrets (control's, when users move over).
    AUTH_SECRET: z.string().optional(),
    // Social sign-in, each on when its client ID and secret are set. Redirect URI <PUBLIC_URL>/social/<name>/callback.
    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),
    FACEBOOK_CLIENT_ID: z.string().optional(),
    FACEBOOK_CLIENT_SECRET: z.string().optional(),
    MICROSOFT_CLIENT_ID: z.string().optional(),
    MICROSOFT_CLIENT_SECRET: z.string().optional(),
    // common (personal and work accounts), consumers, organizations, or one directory's id.
    MICROSOFT_TENANT: z.string().default("common"),
    SEZNAM_CLIENT_ID: z.string().optional(),
    SEZNAM_CLIENT_SECRET: z.string().optional(),
    // Email (sign-in links): Emailit's HTTP API wins over SMTP. Without either, development prints them.
    EMAILIT_API_KEY: z.string().optional(),
    SMTP_URL: z.string().optional(),
    MAIL_FROM: z.string().default("Osiris <auth@k6labs.cz>"),
    // Forwarded client addresses are taken only from these (the ingress), CF-Connecting-IP only behind CDN_PROXIES.
    TRUSTED_PROXIES: z.string().default("10.0.0.0/8,127.0.0.1/32,::1/128"),
    CDN_PROXIES: z.string().default(""),
    // The built pages (`server/auth/web`: sign-in, account, admin).
    STATIC_DIR: z.string().default("./web/dist"),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== "production") return;
    for (const key of ["AUTH_SIGNING_KEY", "AUTH_SECRET"] as const) {
      if (!env[key]) ctx.addIssue({ code: "custom", path: [key], message: "is required in production" });
    }
    if (!env.PUBLIC_URL.startsWith("https://")) ctx.addIssue({ code: "custom", path: ["PUBLIC_URL"], message: "must be https in production" });
  })
  .superRefine((env, ctx) => {
    if (env.AUTH_SECRET && Buffer.from(env.AUTH_SECRET, "base64").length !== 32) {
      ctx.addIssue({ code: "custom", path: ["AUTH_SECRET"], message: "must be 32 bytes, base64-encoded" });
    }
    for (const p of ["GOOGLE", "FACEBOOK", "MICROSOFT", "SEZNAM"] as const) {
      if (!env[`${p}_CLIENT_ID`] !== !env[`${p}_CLIENT_SECRET`]) {
        ctx.addIssue({ code: "custom", path: [`${p}_CLIENT_SECRET`], message: `${p}_CLIENT_ID and ${p}_CLIENT_SECRET go together` });
      }
    }
  });

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) throw new Error(`Invalid configuration:\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
}
