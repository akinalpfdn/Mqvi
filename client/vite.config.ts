import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Don't clear console — Tauri CLI prints logs there too
  clearScreen: false,
  server: {
    port: 3030,
    strictPort: true, // Fail if port is taken — Tauri expects a fixed port
    // Backend API proxy — routes /api/* and /ws/* to the Go backend in development.
    proxy: {
      "/api": {
        target: "http://localhost:9090",
        changeOrigin: true,
      },
      "/ws": {
        target: "ws://localhost:9090",
        ws: true,
      },
    },
  },
  // Expose VITE_ and TAURI_ENV_ prefixed env vars to the frontend
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    // Tauri uses Chromium (WebView2) on Windows, WebKit on macOS/Linux
    target:
      process.env.TAURI_ENV_PLATFORM === "windows"
        ? "chrome105"
        : "safari13",
    // Full minification for release, skip for debug builds
    minify: !process.env.TAURI_ENV_DEBUG ? "esbuild" : false,
    // Source maps for debug builds only
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
});
