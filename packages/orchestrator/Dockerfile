FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/orchestrator/package.json ./packages/orchestrator/
COPY prisma ./prisma
RUN npm install -g pnpm && pnpm install --filter orchestrator
COPY packages/orchestrator ./packages/orchestrator
RUN cd packages/orchestrator && pnpm build
RUN pnpm dlx prisma generate --schema=prisma/schema.prisma

FROM node:22-alpine
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/orchestrator/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/packages/orchestrator/package.json ./
ENV NODE_ENV=production
CMD ["node", "dist/index.js"]
