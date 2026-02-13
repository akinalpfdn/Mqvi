import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    strictPort: true, // 3000 doluysa başka port'a geçmesin, hata versin
    // Backend API proxy — development'ta CORS sorunlarını önler.
    // Frontend'den /api/* istekleri otomatik olarak Go server'a yönlendirilir.
    proxy: {
      "/api": {
        target: "http://localhost:8080",
        changeOrigin: true,
      },
      "/ws": {
        target: "ws://localhost:8080",
        ws: true,
      },
    },
  },
});
