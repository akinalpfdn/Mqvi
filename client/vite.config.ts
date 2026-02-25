import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 3030,
    strictPort: true, // Fail if port is taken — Electron dev expects a fixed port
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
  envPrefix: ["VITE_"],
  // Electron production'da file:// protokolü kullanır.
  // base: './' ile asset path'leri relative olur (./assets/...)
  // Varsayılan '/' → '/assets/...' → file:// ile C:\assets\ gibi yanlış path oluşturur.
  base: "./",
  build: {
    // Electron uses Chromium — target latest Chrome for full ES2020+ support
    target: "chrome120",
    minify: "esbuild",
    sourcemap: false,
  },
});
