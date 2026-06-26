FROM mcr.microsoft.com/playwright:v1.61.0-jammy AS builder
WORKDIR /app
COPY tsconfig.base.json .
COPY packages/worker/package.json packages/worker/
RUN cd packages/worker && npm install
COPY packages/worker packages/worker/
RUN cd packages/worker && npm run build

FROM mcr.microsoft.com/playwright:v1.61.0-jammy
WORKDIR /app
RUN apt-get update && apt-get install -y xvfb && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/packages/worker/node_modules ./node_modules
COPY --from=builder /app/packages/worker/dist ./dist
COPY --from=builder /app/packages/worker/package.json ./
# Chrome extension that exposes window.__captureTab() via captureVisibleTab().
# This gives GPU-composited screenshots with all 9 captcha tiles rendered.
COPY packages/worker/captcha-extension /app/captcha-extension
ENV NODE_ENV=production
ENV DISPLAY=:99
CMD ["sh", "-c", "rm -f /tmp/.X99-lock && Xvfb :99 -screen 0 1920x1080x24 -ac +extension GLX +render -noreset & sleep 2 && node dist/index.js"]
