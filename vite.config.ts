/// <reference types="vitest" />

import { URL, fileURLToPath } from "url";

import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const aliases = [
  {
    find: "@src",
    replacement: fileURLToPath(new URL("./src", import.meta.url)),
  },
  { find: "@", replacement: fileURLToPath(new URL("./src", import.meta.url)) },
  {
    find: "core",
    replacement: fileURLToPath(new URL("./src/core", import.meta.url)),
  },
  {
    find: "utils",
    replacement: fileURLToPath(new URL("./src/utils", import.meta.url)),
  },
];

// https://vitejs.dev/config/
export default defineConfig(() => ({
  plugins: [react(), tailwindcss()],
  test: {
    environment: "jsdom",
    globals: true,
  },
  resolve: {
    alias: aliases,
  },
  build: {
    // sourcemap: true,
    // minify: false,
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
