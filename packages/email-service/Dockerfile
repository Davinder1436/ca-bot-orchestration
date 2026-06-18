FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/email-service/package.json ./packages/email-service/
RUN npm install -g pnpm && pnpm install --filter email-service
COPY packages/email-service ./packages/email-service
RUN cd packages/email-service && pnpm build

FROM node:22-alpine
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/email-service/dist ./dist
COPY --from=builder /app/packages/email-service/package.json ./
ENV NODE_ENV=production
CMD ["node", "dist/index.js"]
