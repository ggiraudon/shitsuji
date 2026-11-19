# syntax=docker/dockerfile:1
# Shitsuji core. Build from the repository root:
#   docker build -f packages/core/Dockerfile -t shitsuji/core .
# node_modules are installed inside the image, never mounted from the host.

FROM node:22-bookworm-slim AS build
WORKDIR /repo
RUN corepack enable

# Dependencies first, so source changes do not reinstall them.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/shared/package.json packages/shared/
COPY packages/sandbox-protocol/package.json packages/sandbox-protocol/
RUN pnpm install --frozen-lockfile --filter @shitsuji/core...

# packages/shared is a git submodule (shitsuji-shared): clone with --recurse-submodules.
COPY packages/shared packages/shared
COPY packages/sandbox-protocol packages/sandbox-protocol
COPY packages/core packages/core
RUN pnpm --filter @shitsuji/core... build \
 && pnpm --filter @shitsuji/core deploy --prod --legacy /out

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    SHITSUJI_LOG_FORMAT=json \
    SHITSUJI_DATA_DIR=/data
WORKDIR /app
COPY --from=build --chown=node:node /out ./
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
# Migrations run at startup; a failed migration or unreachable database stops the process.
CMD ["node", "dist/cli.js"]
