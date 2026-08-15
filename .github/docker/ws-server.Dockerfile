# ==============================================================================
# CI Dockerfile for tanoclo-ws-server (multi-arch)
# Build context: repository root
# Usage: docker buildx build --platform linux/amd64,linux/arm64 -f .github/docker/ws-server.Dockerfile .
# ==============================================================================
FROM ghcr.io/home-assistant/amd64-base-debian:latest AS base-amd64
FROM ghcr.io/home-assistant/aarch64-base-debian:latest AS base-arm64

ARG TARGETARCH
# hadolint ignore=DL3006
FROM base-${TARGETARCH}

# Install curl, ca-certificates, build essentials, and nodejs
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    build-essential \
    python3 \
    && curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy ws-server source from the checked-out repo
COPY ws-server/ ./ws-server/

# Install npm dependencies (production only)
WORKDIR /app/ws-server
RUN npm ci --only=production

# Copy the addon entrypoint
WORKDIR /app
COPY tanoclo-ws-server/addon-entrypoint.js ./tanoclo-ws-server/

WORKDIR /app/ws-server

ENTRYPOINT []
CMD [ "node", "/app/tanoclo-ws-server/addon-entrypoint.js" ]
