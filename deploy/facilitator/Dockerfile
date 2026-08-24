# Self-hosted reference facilitator (DrVelvetFog/sui-x402-facilitator), run
# unmodified. The source is cloned at build time at the same commit the
# deploy/facilitator/upstream submodule pins (build platforms such as Railway
# do not fetch submodules). Keep UPSTREAM_COMMIT in lockstep with the
# submodule; see UPSTREAM.md.
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

ARG UPSTREAM_REPO=https://github.com/DrVelvetFog/sui-x402-facilitator
ARG UPSTREAM_COMMIT=37bb8f7920bd602f9c209cab36b38f226cd1c3ea
RUN apk add --no-cache git \
 && git clone "$UPSTREAM_REPO" /tmp/upstream \
 && git -C /tmp/upstream checkout "$UPSTREAM_COMMIT" \
 && cp /tmp/upstream/package.json /tmp/upstream/package-lock.json ./ \
 && npm ci --omit=dev --ignore-scripts \
 && cp -r /tmp/upstream/src ./src \
 && cp /tmp/upstream/tsconfig.json ./ \
 && rm -rf /tmp/upstream /root/.npm \
 && apk del git

ENV PORT=4402
EXPOSE 4402
USER node

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:4402/health > /dev/null || exit 1

CMD ["node_modules/.bin/tsx", "src/index.ts"]
