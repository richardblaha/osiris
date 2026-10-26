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
    // Same origin as in production: the API through the gateway (sign-in is osiris-auth's, on :3003).
    proxy: Object.fromEntries(["/api", "/public", "/auth-config.json", "/project-logos"].map((p) => [p, "http://localhost:3001"])),
  },
});
