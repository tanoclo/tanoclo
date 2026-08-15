# ==============================================================================
# CI Dockerfile for tanoclo-stream-receiver (multi-arch)
# Build context: tanoclo-stream-receiver/
# Usage: docker buildx build --platform linux/amd64,linux/arm64 -f .github/docker/stream-receiver.Dockerfile tanoclo-stream-receiver/
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

# Copy dependency configs
COPY package*.json ./

# Install npm dependencies (production only)
RUN npm ci --only=production

# Copy source code
COPY stream_receiver.js addon-entrypoint.js sync_tlv_labels.js config.json.example ./
COPY lib/ ./lib/
COPY tlv_labels.json ./

ENTRYPOINT []
CMD ["node", "/app/addon-entrypoint.js"]
