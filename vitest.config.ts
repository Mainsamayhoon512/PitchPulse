import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Never touch real data: a dummy provider token, and Redis database 15 instead of the default one.
    env: {
      ENTITY_TOKEN: "test-token",
      REDIS_URL: process.env.TEST_REDIS_URL ?? "redis://localhost:6379/15",
    },
  },
});
