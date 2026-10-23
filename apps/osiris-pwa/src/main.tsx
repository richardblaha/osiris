import "./i18n.ts";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { useTranslation } from "react-i18next";
import { App } from "./App.tsx";
import { handleCallback } from "./auth.ts";
import "./index.css";

await handleCallback();

/**
 * Components read texts with i18next's `t` as they render; a change of language renders the app anew (its place is
 * in the URL, so it stays where it was).
 */
function Localized() {
  const { i18n } = useTranslation();
  return <App key={i18n.language} />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Localized />
  </StrictMode>,
);
