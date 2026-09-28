import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, ".") },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 120000,
    hookTimeout: 120000,
    // Each DB-backed test file spawns `npx prisma db push` (a full Node
    // subprocess) and runs its own Prisma client. With one worker per core,
    // small runners oversubscribe CPU and the tightest per-test budget
    // (operator-flow pins 60s) expires under load. Two workers keep every
    // per-test budget reachable without serializing the whole suite.
    maxWorkers: 2,
  },
});
