import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The identity provider's pages (sign-in, account, administration). osiris-auth serves the build; in development
// Vite serves them and passes the provider's own paths on to it (:3003).
const provider = ["/api", "/interaction", "/scim", "/authorize", "/token", "/logout", "/social", "/link", "/pictures", "/static", "/account/signin", "/account/callback"];

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5174, strictPort: true, proxy: Object.fromEntries(provider.map((p) => [p, "http://localhost:3003"])) },
});
