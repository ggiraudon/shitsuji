# syntax=docker/dockerfile:1
# Shitsuji's egress proxy (F08, S47). Build from the repository root:
#   docker build -f docker/egress-proxy/Dockerfile -t shitsuji/egress .
# The sandbox's only way out: it refuses private, loopback, link-local, CGNAT and metadata addresses
# on the resolved IP. The base image is pinned by digest.

ARG NODE_IMAGE=node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee

FROM ${NODE_IMAGE} AS build
WORKDIR /repo
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/egress-proxy/package.json packages/egress-proxy/
RUN pnpm install --frozen-lockfile --filter @shitsuji/egress-proxy...

COPY packages/egress-proxy packages/egress-proxy
RUN pnpm --filter @shitsuji/egress-proxy build \
 && pnpm --filter @shitsuji/egress-proxy deploy --prod --legacy /out

FROM ${NODE_IMAGE}
ENV NODE_ENV=production \
    SANDBOX_EGRESS_PORT=3128
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
EXPOSE 3128
CMD ["node", "dist/main.js"]
