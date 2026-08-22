import { buildApp, bootstrapAdmin } from "./app.js";
import { config } from "./config.js";

const { app, ctx } = await buildApp({ databaseUrl: config.databaseUrl, pgliteDir: config.pgliteDir, redisUrl: config.redisUrl, storageDir: config.storageDir, logger: true });

const key = await bootstrapAdmin(ctx, config.adminScreenName, config.adminEmail);
if (key) {
  app.log.warn(`\n\n  Bootstrap admin "${config.adminScreenName}" created.\n  API key (shown once): ${key}\n`);
}

await app.listen({ port: config.port, host: "0.0.0.0" });
app.log.info(`BuddyList server on http://localhost:${config.port}  (db: ${config.databaseUrl ? "postgres" : "pglite"}, bus: ${config.redisUrl ? "redis" : "memory"})`);

for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => void app.close().then(() => process.exit(0)));
