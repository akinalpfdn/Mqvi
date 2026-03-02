import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vite.dev/config/
// command: "serve" → dev server (vite dev), "build" → production build (vite build)
//
// base farkı neden gerekli?
// - Dev (serve): base "/" → script src="/src/main.tsx" (absolute)
//   SPA routing ile /invite/abc gibi nested path'lerde JS modülleri doğru yüklenir.
//   Eğer "./" olursa → tarayıcı ./src/main.tsx'i /invite/src/main.tsx olarak çözer → 404.
//
// - Build: base "./" → script src="./assets/index-xxx.js" (relative)
//   Electron file:// protokolünde absolute "/" → C:\ gibi yanlış path oluşturur.
//   Relative "./" ile doğru çalışır.
export default defineConfig(({ command }) => ({
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
  base: command === "serve" ? "/" : "./",
  build: {
    // Electron uses Chromium — target latest Chrome for full ES2020+ support
    target: "chrome120",
    minify: "esbuild",
    sourcemap: false,
  },
}));
