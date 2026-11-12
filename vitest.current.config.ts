import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Pi 0.85 loads legacy extensions against its bundled pi-ai/compat entrypoint.
// The default test run covers the earlier root exports (pi-ai 0.74).
export default defineConfig({
	resolve: {
		alias: [{ find: /^@earendil-works\/pi-ai$/, replacement: fileURLToPath(import.meta.resolve("pi-ai-current/compat")) }],
	},
	test: { include: ["test/**/*.test.ts"] },
});
