import "./i18n.ts";
import { connect } from "@osiris/client/api.ts";
import { t } from "i18next";
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { AccountActivity } from "./AccountActivity.tsx";
import { currentLocale } from "./i18n.ts";
import { Security, type SecurityPart } from "./Security.tsx";
import { SignIn } from "./SignIn.tsx";
import "./index.css";

// osiris-auth serves this page at /login and /account. Its API is on the same origin and knows the user from the
// browser's sign-in session (a cookie); the client wants a token, so it gets a placeholder nobody reads.
connect({ url: "", token: async () => "session", signIn: async () => window.location.assign("/account/signin"), locale: currentLocale });

type Part = SecurityPart | "activity";
const PARTS: Part[] = ["passkeys", "password", "totp", "linked", "activity"];

/** The user's own account: sign-in methods, linked accounts, sign-ins and sessions; back to Osiris or sign out. */
function Account() {
  const params = new URLSearchParams(location.search);
  const notice = params.has("linked") || params.has("error") ? { linked: params.get("linked") ?? undefined, error: params.get("error") ?? undefined } : undefined;
  const [part, setPart] = useState<Part>(notice ? "linked" : "passkeys");
  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-8">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          <img src="/favicon.svg" alt="" className="h-7 w-7" /> {t("profile:parts.security")}
        </h1>
        <a className="btn-danger text-sm" href="/logout?client_id=osiris-account">
          {t("app:signOut")}
        </a>
      </header>
      <nav className="flex flex-wrap gap-2" aria-label={t("profile:parts.security")}>
        {PARTS.map((p) => (
          <button key={p} onClick={() => setPart(p)} className={p === part ? "btn-primary text-sm" : "btn-secondary text-sm"} aria-current={p === part ? "page" : undefined}>
            {t(`profile:parts.${p}`)}
          </button>
        ))}
      </nav>
      <main className="detail">{part === "activity" ? <AccountActivity /> : <Security key={part} part={part} notice={part === "linked" ? notice : undefined} />}</main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode>{location.pathname === "/login" ? <SignIn /> : <Account />}</StrictMode>);
