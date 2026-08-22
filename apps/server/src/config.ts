import "dotenv/config";

export const config = {
  port: Number(process.env.PORT ?? 4000),
  databaseUrl: process.env.DATABASE_URL, // undefined => PGlite
  pgliteDir: process.env.PGLITE_DIR ?? "./.pglite",
  redisUrl: process.env.REDIS_URL, // undefined => in-memory bus
  adminScreenName: process.env.ADMIN_SCREEN_NAME ?? "admin",
  adminEmail: process.env.ADMIN_EMAIL ?? "admin@localhost",
  heartbeatIdleMs: 10 * 60 * 1000,
  socketTimeoutMs: 60 * 1000,
  storageDir: process.env.STORAGE_DIR ?? "./.storage",
  /** Built web client to serve on the same origin. Set WEB_DIR="" to serve the API only. */
  webDir: process.env.WEB_DIR ?? "apps/web/dist",
  rateLimit: { perMinute: 60, burst: 20 },
};
