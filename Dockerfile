# syntax=docker/dockerfile:1

FROM node:24-alpine AS builder
WORKDIR /build

COPY tsconfig.base.json LICENSE NOTICE THIRD_PARTY_NOTICES.md ./
COPY packages/service/package.json ./packages/service/package.json

WORKDIR /build/packages/service
RUN npm install --no-audit --no-fund

WORKDIR /build
COPY packages/service ./packages/service

WORKDIR /build/packages/service
RUN node ./build.ts

FROM node:24-alpine AS prod-deps
WORKDIR /app/packages/service

COPY packages/service/package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund

FROM node:24-alpine AS runtime
WORKDIR /app

COPY --from=prod-deps /app/packages/service/node_modules ./packages/service/node_modules
COPY --from=builder /build/packages/service/dist ./packages/service/dist
COPY --from=builder /build/packages/service/package.json ./packages/service/package.json
COPY --from=builder /build/packages/service/osdk-sets.json ./packages/service/osdk-sets.json
COPY --from=builder /build/packages/service/LICENSE ./packages/service/LICENSE
COPY --from=builder /build/packages/service/NOTICE ./packages/service/NOTICE
COPY --from=builder /build/packages/service/THIRD_PARTY_NOTICES.md ./packages/service/THIRD_PARTY_NOTICES.md

ENV PORT=8080
EXPOSE 8080

USER node

HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/api/ontology-service/v1/client-config').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "packages/service/dist/node.js"]
