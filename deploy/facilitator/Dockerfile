# Self-hosted reference facilitator (DrVelvetFog/sui-x402-facilitator), run
# unmodified. Build context = this directory; source comes from the pinned
# submodule in ./upstream (see UPSTREAM.md). Upstream runs via tsx with no
# build step, so we do the same.
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY upstream/package.json upstream/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY upstream/src ./src
COPY upstream/tsconfig.json ./

ENV PORT=4402
EXPOSE 4402
USER node

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:4402/health > /dev/null || exit 1

CMD ["node_modules/.bin/tsx", "src/index.ts"]
