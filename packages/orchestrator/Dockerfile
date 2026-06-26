FROM node:22-alpine AS builder
WORKDIR /app
RUN apk add --no-cache openssl
COPY tsconfig.base.json .
COPY packages/orchestrator/package.json packages/orchestrator/
COPY prisma prisma/
RUN cd packages/orchestrator && npm install
# Generate Prisma client types BEFORE TypeScript compilation (use local v5 bin, not npx which fetches latest)
RUN cd packages/orchestrator && ./node_modules/.bin/prisma generate --schema=../../prisma/schema.prisma
COPY packages/orchestrator packages/orchestrator/
RUN cd packages/orchestrator && npm run build

FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache openssl
COPY --from=builder /app/packages/orchestrator/node_modules ./node_modules
COPY --from=builder /app/packages/orchestrator/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/packages/orchestrator/package.json ./
ENV NODE_ENV=production
CMD ["node", "dist/index.js"]
