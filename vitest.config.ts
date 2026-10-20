import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("migrations");
  return {
    plugins: [cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: migrations,
          MAI_SECRET_KEY: "segredo-de-teste",
          MAI_ENCRYPTION_KEY: btoa("k".repeat(32)),
        },
      },
    })],
    test: { setupFiles: ["./test/setup.ts"], testTimeout: 60000, hookTimeout: 120000 },
  };
});
