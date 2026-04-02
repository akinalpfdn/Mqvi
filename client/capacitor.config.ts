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
    allowMixedContent: true,
  },

  plugins: {
    Keyboard: {
      resize: "none",
    },
  },
};

export default config;
