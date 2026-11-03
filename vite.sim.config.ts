import { defineConfig } from "vite";

// The simulator host page for the Android app (`npm run build:sim`): a small
// bundle in the app's assets. Scene images are not copied here; the app's
// Gradle build adds web/public/scenes to its assets itself.
export default defineConfig({
  root: "web/sim-host",
  base: "./",
  publicDir: false,
  build: {
    outDir: "../../android/app/src/main/assets/sim",
    emptyOutDir: true,
    target: "es2022",
    modulePreload: false,
    rollupOptions: {
      // Stable names, so a rebuild without changes leaves the committed files alone.
      output: { entryFileNames: "host.js", chunkFileNames: "[name].js", assetFileNames: "[name][extname]" },
    },
  },
  worker: {
    format: "es",
    rollupOptions: { output: { entryFileNames: "camera-worker.js", chunkFileNames: "[name].js" } },
  },
});
