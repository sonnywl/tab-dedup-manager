import { URL, fileURLToPath } from "url";

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const aliases = [{ find: "utils", url: "./src/utils" }];

// https://vitejs.dev/config/
export default defineConfig((configEnv) => ({
  plugins: [react()],
  resolve: {
    alias: aliases.map((a) => ({
      find: a.find,
      replacement: fileURLToPath(new URL(a.url, import.meta.url)),
    })),
  },
  build: {
    sourcemap: configEnv.mode === "development",
    outDir: "./build",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        sourcemapBaseUrl: "http://localhost",
        entryFileNames: `assets/[name].js`,
        chunkFileNames: `assets/[name].js`,
        assetFileNames: `assets/[name].[ext]`,
      },
    },
  },
}));
