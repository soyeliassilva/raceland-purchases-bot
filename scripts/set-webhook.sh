#!/bin/bash

# Set Telegram webhook for DGII Purchase Tracker Bot
# Usage: ./scripts/set-webhook.sh

set -e

# Configuration - update these values
BOT_TOKEN="${TELEGRAM_BOT_TOKEN}"
WEBHOOK_SECRET="${TELEGRAM_WEBHOOK_SECRET}"
WORKER_URL="${WORKER_URL:-https://dgii-purchase-tracker.YOUR_SUBDOMAIN.workers.dev}"

if [ -z "$BOT_TOKEN" ]; then
  echo "Error: TELEGRAM_BOT_TOKEN environment variable is required"
  echo "Usage: TELEGRAM_BOT_TOKEN=xxx TELEGRAM_WEBHOOK_SECRET=yyy ./scripts/set-webhook.sh"
  exit 1
fi

if [ -z "$WEBHOOK_SECRET" ]; then
  echo "Error: TELEGRAM_WEBHOOK_SECRET environment variable is required"
  exit 1
fi

echo "Setting webhook to: $WORKER_URL"

curl -X POST "https://api.telegram.org/bot${BOT_TOKEN}/setWebhook" \
  -H "Content-Type: application/json" \
  -d "{
    \"url\": \"${WORKER_URL}\",
    \"secret_token\": \"${WEBHOOK_SECRET}\"
  }"

echo ""
echo "Done! Verify with: curl https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo"
