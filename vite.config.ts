import { URL, fileURLToPath } from "url";

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const aliases = [{ find: "utils", url: "./src/utils" }];

// https://vitejs.dev/config/
export default defineConfig((configEnv) => ({
  plugins: [react(), tailwindcss()],
  publicDir: "./public",
  envDir: "./",
  resolve: {
    alias: aliases.reduce((acc, curr) => {
      acc[curr.find] = fileURLToPath(new URL(curr.url, import.meta.url));
      return acc;
    }, {}),
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
