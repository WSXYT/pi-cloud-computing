FROM node:24-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends git openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
ARG PI_VERSION=1.0.0
RUN npm install --global "@earendil-works/pi-coding-agent@${PI_VERSION}" --ignore-scripts \
    && mkdir -p node_modules/@earendil-works \
    && ln -s "$(npm root -g)/@earendil-works/pi-coding-agent" node_modules/@earendil-works/pi-coding-agent
COPY dist ./dist

ENV PI_CLOUD_DATA_DIR=/var/lib/pi-cloud
ENV PI_CLOUD_RUNNER=host
VOLUME ["/var/lib/pi-cloud"]
EXPOSE 9443
ENTRYPOINT ["node", "dist/src/cli.js", "worker", "serve"]
