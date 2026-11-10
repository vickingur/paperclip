import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["server/src/__tests__/pinned-tool-assignment.test.ts", "server/src/__tests__/plugin-assignment-inventory.test.ts"], testTimeout: 60000 } });
