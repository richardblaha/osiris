import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { handleCallback } from "./auth.ts";
import { App } from "./App.tsx";
import "./index.css";

// Completes the OIDC redirect first (it rewrites the URL), then the app renders the path it came back to.
void handleCallback().then(() => {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
