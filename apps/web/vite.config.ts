import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        // Two front doors from one build: the retro client and the operator dashboard.
        main: resolve(import.meta.dirname, "index.html"),
        dashboard: resolve(import.meta.dirname, "dashboard.html"),
      },
    },
  },
  server: {
    port: 5173,
    proxy: { "/api": "http://localhost:4000", "/ws": { target: "ws://localhost:4000", ws: true } },
  },
});
