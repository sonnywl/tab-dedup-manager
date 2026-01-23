import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vitejs.dev/config/
export default defineConfig((configEnv) => ({
  plugins: [react()],
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
