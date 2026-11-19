# syntax=docker/dockerfile:1
# Shitsuji's sandbox image (F08, S45). Build from the repository root:
#   docker build -f docker/sandbox/Dockerfile -t shitsuji/sandbox .
# It runs sandboxd and the tools the agent uses. Exec supervision and egress control arrive in S46
# and S47; it joins compose.yaml in S48.
#
# The base image is pinned by digest so a rebuild does not silently change Debian packages.

ARG NODE_IMAGE=node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee

FROM ${NODE_IMAGE} AS build
WORKDIR /repo
RUN corepack enable

# Dependencies first, so source changes do not reinstall them.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/sandbox-protocol/package.json packages/sandbox-protocol/
COPY packages/sandbox-daemon/package.json packages/sandbox-daemon/
RUN pnpm install --frozen-lockfile --filter @shitsuji/sandbox-daemon...

COPY packages/sandbox-protocol packages/sandbox-protocol
COPY packages/sandbox-daemon packages/sandbox-daemon
RUN pnpm --filter @shitsuji/sandbox-daemon... build \
 && pnpm --filter @shitsuji/sandbox-daemon deploy --prod --legacy /out

FROM ${NODE_IMAGE}
ENV NODE_ENV=production \
    SANDBOX_PORT=4555 \
    SANDBOX_WORKSPACE=/workspace \
    SANDBOX_HANDOFF=/handoff \
    PYTHONUNBUFFERED=1 \
    NPM_CONFIG_PREFIX=/home/agent/.npm-global \
    SANDBOX_TOKEN_FILE=/run/sandbox/token \
    PATH=/home/agent/.npm-global/bin:/home/agent/.local/bin:$PATH

# The tools the agent is promised (F08). Python first-class, plus the document, media and search
# utilities; no compilers or shells beyond what Debian ships.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    ffmpeg \
    file \
    git \
    jq \
    less \
    pandoc \
    passwd \
    poppler-utils \
    procps \
    python3 \
    python3-pip \
    python3-venv \
    ripgrep \
    sqlite3 \
    tesseract-ocr \
    unzip \
    util-linux \
    zip \
 && rm -rf /var/lib/apt/lists/*

# User 1000, named agent: the node image's `node` user already holds that id, so rename it. The
# daemon runs as 1001: the split is what keeps the token out of a command's reach (S46).
RUN groupmod -n agent node \
 && usermod -l agent -d /home/agent -m node \
 && useradd -u 1001 -g agent -M -d /home/sandboxd -s /usr/sbin/nologin sandboxd \
 && mkdir -p /home/agent /home/sandboxd /workspace /handoff /run/sandbox /run/sandbox-seed \
 && chown -R agent:agent /home/agent /workspace /handoff \
 && chown 1001:1000 /home/sandboxd /run/sandbox \
 && chown 0:1002 /run/sandbox-seed \
 && chmod 0700 /run/sandbox \
 && chmod 0770 /run/sandbox-seed \
 && chmod 2770 /workspace \
 && chmod 2750 /handoff

# Belt-and-braces: no setuid binary in the image. Commands already run with no capabilities and
# no-new-privs, but a setuid file buys nothing here and could only be a way back up.
RUN find / -xdev -perm -4000 -exec chmod u-s {} +

WORKDIR /app
COPY --from=build --chown=agent:agent /out ./
COPY --chmod=0755 docker/sandbox/entrypoint.sh /usr/local/bin/sandbox-entrypoint
EXPOSE 4555
# The entrypoint starts as root, prepares the token file and workspace, then drops to uid 1001.
# Compose mounts the secret volume (root:1002 0770, token 0644) read-only at /run/sandbox-seed; CI
# and development set SANDBOX_TOKEN instead.
ENTRYPOINT ["/usr/local/bin/sandbox-entrypoint"]



