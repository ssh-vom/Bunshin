FROM node:22-alpine AS build
WORKDIR /app

RUN apk add --no-cache git

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app

ARG GLOBBY_CLI_REPO=https://github.com/jamiebuilds/globby-cli.git
ARG GLOBBY_CLI_REF=master

ENV NODE_ENV=production
ENV GLOBBY_CLI_DIR=/workspace/globby-cli

RUN apk add --no-cache git bash ripgrep

RUN mkdir -p /Users/shivom /workspace \
  && git clone --depth=1 --branch "${GLOBBY_CLI_REF}" "${GLOBBY_CLI_REPO}" "${GLOBBY_CLI_DIR}"

RUN npm install -g @mariozechner/pi-coding-agent

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist
COPY pi-extension ./pi-extension

RUN printf '#!/bin/sh\nnode /app/dist/cli/index.js "$@"\n' > /usr/local/bin/bunshin \
  && chmod +x /usr/local/bin/bunshin

CMD ["sleep", "infinity"]
