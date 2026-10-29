import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { getRunContext } from "@osiris/core/agent/context.ts";
import type { ToolModule } from "@osiris/core/tools/module.ts";
import { davTools } from "./dav.ts";
import { googleTools } from "./google.ts";
import { mailTools } from "./mail.ts";
import { microsoftTools } from "./microsoft.ts";

/** Users' own accounts: Google and Microsoft (mail, contacts, calendar), SMTP/IMAP/POP3 mail, CalDAV and CardDAV. */
export function integrationsModule(): ToolModule {
  return {
    name: "integrations",
    feature: "integrations",
    create: (host) => {
      const accounts = host.standardAccounts;
      const standard = tool(async (_, config) => JSON.stringify(await accounts.list(getRunContext(config).user_id)), {
        name: "standard_accounts",
        description: "Seznam mých propojených účtů pro poštu (SMTP/IMAP/POP3), CalDAV kalendář a CardDAV kontakty. Vrací názvy účtů pro ostatní nástroje.",
        schema: z.object({}),
      });
      return {
        tools: [
          standard,
          ...mailTools(accounts, host.allowPrivate),
          ...davTools(accounts, host.allowPrivate),
          ...googleTools(host.integrations, host.integrationsFetch),
          ...microsoftTools(host.integrations, host.integrationsFetch),
        ],
        // Only the tools of accounts the user connected.
        usable: async (ctx) => {
          const [connected, own] = await Promise.all([host.integrations.connected(ctx.user_id), accounts.list(ctx.user_id)]);
          return (name) =>
            (name === "standard_accounts" && own.length > 0) ||
            connected.some((p) => name.startsWith(`${p}_`)) ||
            own.some((a) => name.startsWith(`${a.kind}_`));
        },
      };
    },
  };
}

export { googleTools, mimeMessage } from "./google.ts";
export { microsoftTools } from "./microsoft.ts";
export { mailTools, safeMailHost } from "./mail.ts";
export { davTools, davFetch } from "./dav.ts";
export { pop3Read } from "./pop3.ts";
