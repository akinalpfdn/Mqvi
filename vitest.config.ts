import { defineConfig } from "vitest/config";

// The client tests itself from client/vitest.config.ts. This one covers the Electron main process,
// which is a separate npm project with its own dependencies: node environment, no jsdom.
export default defineConfig({
  test: {
    environment: "node",
    include: ["electron/**/*.test.ts"],
  },
});
