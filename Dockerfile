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

ENV NODE_ENV=production

RUN apk add --no-cache git bash

RUN mkdir -p /Users/shivom

RUN npm install -g @mariozechner/pi-coding-agent

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist

RUN printf '#!/bin/sh\nnode /app/dist/cli/index.js "$@"\n' > /usr/local/bin/bunshin \
  && chmod +x /usr/local/bin/bunshin

CMD ["sleep", "infinity"]
