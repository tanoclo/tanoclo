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
