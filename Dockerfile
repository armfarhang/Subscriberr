# syntax=docker/dockerfile:1
# Subscriberr — one process, one container (Spec §15).
# Stage 1 builds shared + server + web and compiles better-sqlite3; stage 2 is a slim runtime
# that drops to PUID:PGID before starting the app.

FROM node:22-bookworm-slim AS build
WORKDIR /app

# Toolchain for native modules (better-sqlite3 falls back to compiling when no prebuilt binary fits).
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci

COPY tsconfig.base.json ./
COPY shared shared
COPY server server
COPY web web
RUN npm run build

# Keep only production dependencies (the compiled better-sqlite3 binary stays in place).
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data \
    BACKUP_DIR=/backups \
    TZ=America/Toronto \
    PUID=99 \
    PGID=100

RUN apt-get update \
 && apt-get install -y --no-install-recommends gosu \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/shared/package.json shared/package.json
COPY --from=build /app/shared/dist shared/dist
COPY --from=build /app/server/package.json server/package.json
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/web/dist web/dist
COPY docker/entrypoint.sh /usr/local/bin/subscriberr-entrypoint
RUN chmod 0755 /usr/local/bin/subscriberr-entrypoint

# Milestone 1 spike: fail the build if a native/heavy dependency does not work in this image.
RUN node server/dist/cli.js selfcheck

# /data: database, custom template packs, logos, import staging.
# /backups: verified backups — map it to a DIFFERENT disk/share than /data.
VOLUME ["/data", "/backups"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# Subcommands: serve (default) | restore <file> | verify-backup <file> | integrity-check | selfcheck
ENTRYPOINT ["subscriberr-entrypoint"]
CMD ["serve"]
