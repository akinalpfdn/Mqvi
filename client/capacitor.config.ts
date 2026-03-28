import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "net.mqvi.app",
  appName: "mqvi",
  webDir: "dist",

  // Dev server — uncomment for live reload during development:
  // server: {
  //   url: "http://<YOUR_LOCAL_IP>:3030",
  //   cleartext: true,
  // },

  ios: {
    // WKWebView settings for WebRTC support
    contentInset: "automatic",
    allowsLinkPreview: false,
    scrollEnabled: false,
  },

  android: {
    // Allow mixed content for dev (HTTP API calls)
    allowMixedContent: true,
  },

  plugins: {
    // Keyboard plugin — auto-scroll when keyboard opens
    Keyboard: {
      resize: "body",
      resizeOnFullScreen: true,
    },
  },
};

export default config;
