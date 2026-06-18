FROM mcr.microsoft.com/playwright:v1.46.1-jammy AS base
WORKDIR /app

FROM base AS builder
COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/worker/package.json ./packages/worker/
RUN npm install -g pnpm && pnpm install --filter worker
RUN npx playwright install chromium --with-deps
COPY packages/worker ./packages/worker
RUN cd packages/worker && pnpm build

FROM base
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/worker/dist ./dist
COPY --from=builder /app/packages/worker/package.json ./
# Playwright browser binaries
COPY --from=builder /root/.cache/ms-playwright /root/.cache/ms-playwright
ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/root/.cache/ms-playwright
CMD ["node", "dist/index.js"]
