import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Osiris Digital Twin's PWA. The API serves the build; in development Vite serves the app and passes the API's
// paths on to it (:3004).
const api = ["/api", "/auth-config.json"];

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5175, strictPort: true, proxy: Object.fromEntries(api.map((p) => [p, "http://localhost:3004"])) },
});
