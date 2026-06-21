#!/bin/bash
# Deploy script: pull latest code, verify, and restart both processes
set -e

APP_DIR="/root/courier-shift-bot"
BACKUP_DIR="/root/courier-shift-bot-backups"
SERVICE_BOT="courier-shift-bot"
SERVICE_OCR="gemini-ocr-server"

echo "=== Deploy started at $(date) ==="

# Ensure backup directory exists
mkdir -p "$BACKUP_DIR"

# Create timestamped backup of current code
cd "$APP_DIR"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_PATH="$BACKUP_DIR/backup-$TIMESTAMP.tar.gz"
echo "Creating backup at $BACKUP_PATH..."
tar -czf "$BACKUP_PATH" \
  --exclude='node_modules' \
  --exclude='.git' \
  --exclude='ocr_debug' \
  --exclude='backups' \
  --exclude='*.log' \
  -C "$APP_DIR" .

# Fetch latest changes
echo "Fetching latest changes..."
git fetch origin main

# Check if there are changes to deploy
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)
if [ "$LOCAL" = "$REMOTE" ]; then
  echo "Already up to date ($LOCAL)."
  exit 0
fi

echo "Deploying $LOCAL -> $REMOTE"

# Reset to origin/main (cleaner than pull if history changed)
git reset --hard origin/main

# Install dependencies
echo "Installing dependencies..."
npm ci

# Audit dependencies (do not block deploy, just warn)
echo "Running npm audit..."
npm audit --audit-level=high || echo "WARNING: npm audit found high/critical issues. Review manually."

# Restart OCR server first (bot depends on it)
echo "Restarting $SERVICE_OCR..."
pm2 restart "$SERVICE_OCR" --update-env

# Restart bot
echo "Restarting $SERVICE_BOT..."
pm2 restart "$SERVICE_BOT" --update-env

# Wait and run health check
echo "Waiting for services to start..."
sleep 8

HEALTH_STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:9527/health || echo "000")
if [ "$HEALTH_STATUS" != "200" ]; then
  echo "ERROR: OCR server health check failed (status $HEALTH_STATUS). Rolling back..."
  git reset --hard "$LOCAL"
  pm2 restart "$SERVICE_OCR" --update-env
  pm2 restart "$SERVICE_BOT" --update-env
  exit 1
fi

# Check bot process is online
BOT_STATUS=$(pm2 jlist | python3 -c "import sys,json; d=json.load(sys.stdin); print(next((p['pm2_env']['status'] for p in d if p['name']=='$SERVICE_BOT'), 'NOT_FOUND'))")
if [ "$BOT_STATUS" != "online" ]; then
  echo "ERROR: $SERVICE_BOT is not online (status: $BOT_STATUS). Rolling back..."
  git reset --hard "$LOCAL"
  pm2 restart "$SERVICE_OCR" --update-env
  pm2 restart "$SERVICE_BOT" --update-env
  exit 1
fi

echo "=== Deploy completed successfully at $(date) ==="
