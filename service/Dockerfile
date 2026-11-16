FROM node:24-alpine AS base
# Node's built-in fetch (used by corepack to download pnpm, and by viem for RPC) ignores
# HTTP(S)_PROXY unless this is set. It is a no-op when no proxy variables are present.
ENV NODE_USE_ENV_PROXY=1
RUN corepack enable
WORKDIR /app

FROM base AS build
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build && pnpm prune --prod

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
# Recorded Base history for the offline demo (served by mock-rpc).
COPY fixtures ./fixtures
USER node
EXPOSE 4000
# Migrate, then serve. The migration runner takes an advisory lock, so this is safe with multiple replicas.
CMD ["sh", "-c", "node dist/db/migrate-cli.js && node dist/main.js"]
