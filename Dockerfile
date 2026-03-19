FROM node:24-slim AS builder

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts
COPY tsconfig.build.json tsconfig.json ./
COPY src/ src/
RUN npm run build

FROM node:24-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts
COPY --from=builder /app/dist/ dist/
COPY skills/ skills/

ENV NODE_ENV=production
ENV FEIQUE_STATE_DIR=/data

RUN mkdir -p /data

VOLUME ["/data"]
EXPOSE 3333 9090

ENTRYPOINT ["node", "dist/cli.js"]
CMD ["serve"]
