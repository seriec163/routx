# syntax=docker/dockerfile:1

FROM node:24-alpine AS deps
WORKDIR /app

COPY package.json package-lock.json ./
COPY server/package.json ./server/package.json
COPY web/package.json ./web/package.json

RUN npm ci

FROM node:24-alpine AS build
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN npm run build
RUN node agent/build.mjs
RUN npm prune --omit=dev

FROM node:24-alpine AS runtime
ARG RC_BUILD_SHA=dev
ENV NODE_ENV=production
ENV RC_BUILD_SHA=$RC_BUILD_SHA
WORKDIR /app

# pg_dump/pg_restore нужны для экспорта и переноса базы из панели.
RUN apk add --no-cache postgresql16-client

RUN addgroup -S rc && adduser -S rc -G rc \
    && mkdir -p /app/data \
    && chown rc:rc /app/data

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/package-lock.json ./package-lock.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server/package.json ./server/package.json
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/server/migrations ./server/migrations
COPY --from=build /app/web/dist ./web/dist
COPY --from=build /app/agent/dist ./agent/dist
ENV RC_AGENT_DIST=/app/agent/dist

USER rc
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then((r) => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))"

CMD ["sh", "-c", "node server/dist/migrate-cli.js && node server/dist/index.js"]
