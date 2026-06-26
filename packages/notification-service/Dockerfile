FROM node:22-alpine AS builder
WORKDIR /app
COPY tsconfig.base.json .
COPY packages/notification-service/package.json packages/notification-service/
RUN cd packages/notification-service && npm install
COPY packages/notification-service packages/notification-service/
RUN cd packages/notification-service && npm run build

FROM node:22-alpine
WORKDIR /app
COPY --from=builder /app/packages/notification-service/node_modules ./node_modules
COPY --from=builder /app/packages/notification-service/dist ./dist
COPY --from=builder /app/packages/notification-service/package.json ./
ENV NODE_ENV=production
CMD ["node", "dist/index.js"]
