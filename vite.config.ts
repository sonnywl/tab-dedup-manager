/// <reference types="vitest" />

import { URL, fileURLToPath } from "url";

import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const aliases = [{ find: "utils", url: "./src/utils" }];

// https://vitejs.dev/config/
export default defineConfig((configEnv) => ({
  plugins: [react(), tailwindcss()],
  test: {
    environment: "jsdom",
  },
  resolve: {
    alias: aliases.reduce((acc, curr) => {
      acc[curr.find] = fileURLToPath(new URL(curr.url, import.meta.url));
      return acc;
    }, {}),
  },
  build: {
    sourcemap: "inline",
    outDir: "./build",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        background: "src/background.ts",
        main: "index.html",
      },
      output: {
        sourcemapBaseUrl: "http://localhost",
        entryFileNames: `assets/[name].js`,
        chunkFileNames: `assets/[name].js`,
        assetFileNames: `assets/[name].[ext]`,
      },
    },
  },
}));
