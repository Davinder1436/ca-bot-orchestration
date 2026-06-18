FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/notification-service/package.json ./packages/notification-service/
RUN npm install -g pnpm && pnpm install --filter notification-service
COPY packages/notification-service ./packages/notification-service
RUN cd packages/notification-service && pnpm build

FROM node:22-alpine
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/notification-service/dist ./dist
COPY --from=builder /app/packages/notification-service/package.json ./
ENV NODE_ENV=production
CMD ["node", "dist/index.js"]
