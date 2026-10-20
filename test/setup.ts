import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";

await applyD1Migrations((env as any).DB, (env as any).TEST_MIGRATIONS);
