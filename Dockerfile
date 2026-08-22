# BuddyList — single image serving the API, the WebSocket gateway, and the web client.
# Multi-stage so the runtime image carries no build toolchain or dev dependencies.

FROM node:22-slim AS build
WORKDIR /app

# Manifests first so dependency install caches independently of source changes.
COPY package.json package-lock.json ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/sdk-ts/package.json packages/sdk-ts/
COPY packages/mcp/package.json packages/mcp/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
# --ignore-scripts: the root `prepare` script builds workspaces that don't exist yet at this point.
RUN npm ci --ignore-scripts

COPY tsconfig.base.json ./
COPY packages/ packages/
COPY apps/ apps/

RUN npm run build -w @buddylist/protocol \
 && npm run build -w @buddylist/sdk \
 && npm run build -w @buddylist/server \
 && npm run build -w @buddylist/web

# Prune to production dependencies for the runtime stage.
RUN npm prune --omit=dev --ignore-scripts

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
# Attachments live here; mount a volume at this path to persist them across deploys.
ENV STORAGE_DIR=/data/storage
# Embedded-database fallback also lives on the volume; /app is not writable by the app user.
ENV PGLITE_DIR=/data/pglite

COPY --from=build /app/node_modules node_modules/
COPY --from=build /app/package.json ./
COPY --from=build /app/packages/protocol/dist packages/protocol/dist/
COPY --from=build /app/packages/protocol/package.json packages/protocol/
COPY --from=build /app/apps/server/dist apps/server/dist/
COPY --from=build /app/apps/server/package.json apps/server/
COPY --from=build /app/apps/web/dist apps/web/dist/

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh && mkdir -p /data/storage && chown -R node:node /data
# Starts as root only long enough to fix volume ownership, then drops to `node`.
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "apps/server/dist/index.js"]
