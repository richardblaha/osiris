import { connect } from "@osiris/client/api.ts";
import { getAccessToken, login } from "./auth.ts";
import { currentLocale } from "./i18n.ts";

// The PWA talks to the origin it was loaded from: osiris-server's gateway, or a local agent serving it.
connect({ url: import.meta.env.VITE_API_URL ?? "", token: getAccessToken, signIn: login, locale: currentLocale });

export * from "@osiris/client/api.ts";
