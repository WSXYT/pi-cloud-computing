FROM node:24-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends git openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
RUN npm install --global @earendil-works/pi-coding-agent@0.85.1 --ignore-scripts
COPY dist ./dist

ENV PI_CLOUD_DATA_DIR=/var/lib/pi-cloud
ENV PI_CLOUD_RUNNER=host
VOLUME ["/var/lib/pi-cloud"]
EXPOSE 9443
ENTRYPOINT ["node", "dist/src/cli.js", "worker", "serve"]
