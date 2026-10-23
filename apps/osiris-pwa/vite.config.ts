import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // Bind all interfaces so devcontainer port forwarding reaches it; fail instead of silently moving to another port.
    host: true,
    port: 5173,
    strictPort: true,
    // Same origin as in production: the API and sign-in (control's OIDC provider) through the gateway.
    proxy: { "/api": "http://localhost:3001", "/auth": "http://localhost:3001", "/public": "http://localhost:3001" },
  },
});
