# DGII Purchase Tracker Bot

Telegram bot that tracks Dominican Republic DGII invoice confirmations and stores them in Google Sheets.

## Features

- **URL-based tracking**: Monitors Telegram chat for DGII confirmation URLs (`ecf.dgii.gov.do`)
- **Photo upload support**: Send receipt photos directly in chat, OCR extracts invoice data
- Extracts invoice data from URL parameters and page scraping
- OCR extraction using Cloudflare Workers AI for paper receipts
- Stores invoices in Google Sheets organized by year/month
- Uploads receipt photos to Google Drive (`Facturas/{YYYY}/{month}/`)
- Automatic retry for invoices not yet available (up to 7 days)
- Duplicate detection by ENCF number (and seller RNC for photos)
- User confirmation dialog with editable fields for photo uploads

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

### URL Method (Electronic Invoices)

1. Add the bot to your Telegram group/chat
2. Share DGII confirmation URLs (e.g., `https://ecf.dgii.gov.do/...`)
3. Bot will:
   - Parse the invoice data
   - Add to Google Sheets (auto-creates year spreadsheet and month sheet)
   - Reply with confirmation or queue for retry if not yet available

### Photo Method (Paper Receipts)

1. Send a clear photo of the receipt directly in the chat
2. Bot will:
   - Use OCR to extract invoice data (seller RNC, buyer RNC, NCF/ENCF, date, ITBIS, total)
   - Present a confirmation dialog with extracted data
   - Allow you to edit any field before confirming
   - Upload the original photo to Google Drive
   - Add the invoice to Google Sheets with a link to the photo

3. Use the inline buttons to:
   - Edit individual fields (RNC Emisor, NCF/ENCF, Fecha, ITBIS, Total)
   - Confirm and save (✅ Todo Correcto)
   - Cancel the operation (❌ Cancelar)

### Notes

- **Electronic invoices** (ENCF) and **paper receipts** (NCF) are both supported
- For photo uploads, ensure all text is clearly visible and well-lit
- The bot validates buyer RNC if `BUYER_RNC` is configured
- Duplicate invoices are rejected with a notification message

## Google Sheets & Drive Structure

### Google Sheets
```
Drive Root/
└── Purchases-2026/
    ├── Index (ENCF deduplication)
    ├── January
    ├── February
    └── ...
```

Each month sheet has columns:
Date | Status | ENCF | Vendor RNC | Vendor Name | ITBIS | Total | URL | Added By | Added At

### Google Drive (Photos)
```
Drive Root/
└── Facturas/
    └── 2026/
        ├── Enero/
        │   ├── E310007157932.jpg
        │   └── A0100100100.jpg
        ├── Febrero/
        └── ...
```

- Photo uploads are stored with filename `{NCF or ENCF}.jpg`
- The URL column contains the Drive link for photos, or DGII link for URL invoices
- Security Code column is empty for photo-based invoices

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
| `BUYER_RNC` | Optional: Hardcoded buyer RNC for validation (photo uploads) |
| `ALLOWED_CHAT_IDS` | Optional: Comma-separated list of allowed chat IDs |
