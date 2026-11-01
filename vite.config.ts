import { defineConfig } from "vite";

export default defineConfig({
  root: "web",
  publicDir: "public",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    target: "es2022",
    rollupOptions: { input: { main: "web/index.html" } },
  },
  server: {
    // `npm run dev` serves the web app; /api goes to `npm run dev:worker` on :8790.
    proxy: { "/api": { target: "http://localhost:8790", ws: true } },
  },
});
