FROM node:24-bookworm-slim

ARG PI_VERSION=1.3.0

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global "@earendil-works/pi-coding-agent@${PI_VERSION}" --ignore-scripts

WORKDIR /workspace
ENTRYPOINT []
CMD ["pi", "--version"]
