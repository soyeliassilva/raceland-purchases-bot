# DGII Purchase Tracker Bot

Telegram bot that tracks Dominican Republic DGII invoice confirmations and stores them in Google Sheets.

## Features

- Monitors Telegram chat for DGII confirmation URLs (`ecf.dgii.gov.do`)
- Extracts invoice data from URL parameters and page scraping
- Stores invoices in Google Sheets organized by year/month
- Automatic retry for invoices not yet available (up to 7 days)
- Duplicate detection by ENCF number

## Setup

### 1. Create Telegram Bot

1. Message [@BotFather](https://t.me/BotFather) on Telegram
2. Send `/newbot` and follow prompts
3. Save the bot token

### 2. Google Cloud Setup

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project
3. Enable **Google Sheets API** and **Google Drive API**
4. Go to **IAM & Admin > Service Accounts**
5. Create a service account
6. Create a JSON key and download it
7. Extract `client_email` and `private_key` from the JSON

### 3. Cloudflare Setup

1. Install Wrangler CLI:
   ```bash
   npm install -g wrangler
   ```

2. Login to Cloudflare:
   ```bash
   wrangler login
   ```

3. Create KV namespace:
   ```bash
   wrangler kv:namespace create "PENDING_INVOICES"
   ```

4. Update `wrangler.toml` with the KV namespace ID from the output

### 4. Configure Secrets

```bash
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put TELEGRAM_WEBHOOK_SECRET
wrangler secret put GOOGLE_SERVICE_ACCOUNT_EMAIL
wrangler secret put GOOGLE_PRIVATE_KEY
wrangler secret put SPREADSHEET_FOLDER_ID  # Optional
```

For `TELEGRAM_WEBHOOK_SECRET`, generate a random string (e.g., `openssl rand -hex 32`).

For `GOOGLE_PRIVATE_KEY`, paste the entire private key including `-----BEGIN PRIVATE KEY-----` and `-----END PRIVATE KEY-----`.

### 5. Deploy

```bash
npm install
npm run deploy
```

### 6. Set Webhook

After deployment, set the Telegram webhook:

```bash
./scripts/set-webhook.sh
```

Or manually:

```bash
curl -X POST "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://dgii-purchase-tracker.<your-subdomain>.workers.dev",
    "secret_token": "<WEBHOOK_SECRET>"
  }'
```

## Usage

1. Add the bot to your Telegram group/chat
2. Share DGII confirmation URLs (e.g., `https://ecf.dgii.gov.do/...`)
3. Bot will:
   - Parse the invoice data
   - Add to Google Sheets (auto-creates year spreadsheet and month sheet)
   - Reply with confirmation or queue for retry if not yet available

## Google Sheets Structure

```
Drive Root/
└── Purchases-2026/
    ├── Index (ENCF deduplication)
    ├── January
    ├── February
    └── ...
```

Each month sheet has columns:
Date | ENCF | Vendor RNC | Vendor Name | Buyer RNC | Buyer Name | ITBIS | Total | Status | Security Code | Added By | Added At

## Development

```bash
# Install dependencies
npm install

# Run locally
npm run dev

# Run tests
npm test
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather |
| `TELEGRAM_WEBHOOK_SECRET` | Random secret for webhook verification |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | Service account email |
| `GOOGLE_PRIVATE_KEY` | Service account private key (PEM format) |
| `SPREADSHEET_FOLDER_ID` | Optional: Drive folder ID for spreadsheets |
