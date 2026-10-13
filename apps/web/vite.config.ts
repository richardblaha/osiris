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
    // Same-origin API in development; production sets VITE_API_URL.
    proxy: { "/api": "http://localhost:3001", "/config.js": "http://localhost:3001" },
  },
});
