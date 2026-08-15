ARG BUILD_FROM
FROM $BUILD_FROM

# Install curl, ca-certificates, build essentials, and nodejs
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    build-essential \
    python3 \
    git \
    && curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Clone only the ws-server directory using Git sparse checkout (avoids downloading the entire repo)
RUN REPO_URL="https://github.com/tanoclo/tanoclo.git" \
    && git clone --depth 1 --filter=blob:none --sparse "$REPO_URL" /tmp/repo \
    && cd /tmp/repo \
    && git sparse-checkout set ws-server \
    && cp -r /tmp/repo/ws-server ./ws-server \
    && rm -rf /tmp/repo

# Install npm dependencies (production only)
WORKDIR /app/ws-server
RUN npm ci --omit=dev

# Copy the addon entrypoint from the build context
WORKDIR /app
COPY addon-entrypoint.js ./tanoclo-ws-server/

WORKDIR /app/ws-server

ENTRYPOINT []
CMD [ "node", "/app/tanoclo-ws-server/addon-entrypoint.js" ]
