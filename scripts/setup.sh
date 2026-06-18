#!/bin/bash
# First-time setup script for ca-bot-v2
set -e

echo "=== CA-Bot v2 Setup ==="

# Copy .env if not exists
if [ ! -f .env ]; then
  cp .env.example .env
  echo "✓ Created .env from .env.example — edit it with your keys before continuing"
  echo ""
  echo "Required values to fill in:"
  echo "  POSTGRES_PASSWORD, REDIS_PASSWORD, JWT_SECRET"
  echo "  OPENAI_API_KEY (or CAPMONSTER_API_KEY)"
  echo "  GMAIL_USER, GMAIL_APP_PASSWORD"
  echo "  TELEGRAM_BOT_TOKEN, TELEGRAM_ADMIN_CHAT_ID"
  echo ""
  echo "Then re-run this script."
  exit 0
fi

echo "✓ .env found"

# Install pnpm deps
echo "Installing dependencies..."
pnpm install

# Build Docker images
echo "Building Docker images..."
docker compose build

# Start infra only first (postgres + redis)
echo "Starting postgres + redis..."
docker compose up -d postgres redis

# Wait for postgres
echo "Waiting for postgres..."
until docker compose exec postgres pg_isready -U cabot >/dev/null 2>&1; do
  sleep 2
done
echo "✓ Postgres ready"

# Run Prisma migrations
echo "Running database migrations..."
DATABASE_URL="postgresql://cabot:$(grep POSTGRES_PASSWORD .env | cut -d= -f2)@localhost:5432/cabot" \
  npx prisma migrate deploy --schema=prisma/schema.prisma

echo ""
echo "=== Setup complete! ==="
echo "Start everything with: docker compose up -d"
echo "Scale workers with:    docker compose up --scale worker=20 -d"
echo "Dashboard at:          http://localhost"
echo "Orchestrator API at:   http://localhost:3000"
