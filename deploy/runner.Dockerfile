FROM node:24-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global @earendil-works/pi-coding-agent@0.84.2 --ignore-scripts

WORKDIR /workspace
ENTRYPOINT []
CMD ["pi", "--version"]
