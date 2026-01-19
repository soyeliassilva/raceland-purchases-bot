import { Bot, Context, webhookCallback } from 'grammy';
import type { Env, Invoice } from './types.js';
import { MONTH_NAMES } from './types.js';
import { extractDgiiUrl, fetchInvoice } from './services/dgii.js';
import { addInvoiceToSheet } from './services/sheets.js';

// Bot instance cache (reuse across requests within same Worker instance)
let cachedBot: { bot: Bot; token: string } | null = null;

/**
 * Get display name for user
 */
function getUsername(ctx: Context): string {
  const user = ctx.from;
  if (!user) return 'Unknown';
  if (user.username) return `@${user.username}`;
  if (user.first_name) return user.first_name;
  return `User ${user.id}`;
}

/**
 * Escape special characters for Markdown
 */
export function escapeMarkdown(text: string): string {
  return text.replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
}

/**
 * Format success reply message (ITBIS scraped successfully)
 */
function formatSuccessMessage(invoice: Invoice): string {
  const month = MONTH_NAMES[invoice.fechaEmision.getUTCMonth()];
  const year = invoice.fechaEmision.getUTCFullYear();
  const total = escapeMarkdown(invoice.montoTotal.toFixed(2));
  const itbis = invoice.itbis ? escapeMarkdown(invoice.itbis.toFixed(2)) : 'N/A';

  return [
    '✅ *Factura Agregada*',
    '',
    `📄 ENCF: \`${invoice.encf}\``,
    `🏢 Vendedor: ${escapeMarkdown(invoice.vendorName || invoice.rncEmisor)}`,
    `💰 Total: RD\\$${total}`,
    `📊 ITBIS: RD\\$${itbis}`,
    '',
    `📁 Agregado a: ${escapeMarkdown(month)} ${year}`,
  ].join('\n');
}

/**
 * Format pending message (ITBIS not yet available)
 */
function formatPendingMessage(invoice: Invoice): string {
  const month = MONTH_NAMES[invoice.fechaEmision.getUTCMonth()];
  const year = invoice.fechaEmision.getUTCFullYear();
  const total = escapeMarkdown(invoice.montoTotal.toFixed(2));

  return [
    '⏳ *Factura Agregada \\- Pendiente ITBIS*',
    '',
    `📄 ENCF: \`${invoice.encf}\``,
    `🏢 Vendedor: ${escapeMarkdown(invoice.rncEmisor)}`,
    `💰 Total: RD\\$${total}`,
    '',
    'El ITBIS no está disponible aún en DGII\\.',
    'Se reintentará automáticamente\\.',
    '',
    `📁 Agregado a: ${escapeMarkdown(month)} ${year}`,
  ].join('\n');
}

/**
 * Format duplicate reply message
 */
function formatDuplicateMessage(encf: string): string {
  return `ℹ️ La factura \`${encf}\` ya había sido enviada\\.`;
}

/**
 * Handle DGII URL in message
 */
async function handleDgiiUrl(
  ctx: Context,
  url: string,
  env: Env
): Promise<void> {
  const result = await fetchInvoice(url);

  if (result === 'invalid_url') {
    // Silently ignore invalid URLs
    return;
  }

  const username = getUsername(ctx);

  // Always add to sheet (even if ITBIS is pending)
  const sheetResult = await addInvoiceToSheet(result, username, env);

  if (sheetResult === 'duplicate') {
    await ctx.reply(formatDuplicateMessage(result.encf), { parse_mode: 'MarkdownV2' });
    return;
  }

  // Send appropriate message based on status
  if (result.status === 'Pendiente ITBIS') {
    await ctx.reply(formatPendingMessage(result), { parse_mode: 'MarkdownV2' });
  } else {
    await ctx.reply(formatSuccessMessage(result), { parse_mode: 'MarkdownV2' });
  }
}

/**
 * Get or create bot instance (cached for reuse)
 */
function getBot(env: Env): Bot {
  // Reuse cached bot if token matches
  if (cachedBot && cachedBot.token === env.TELEGRAM_BOT_TOKEN) {
    return cachedBot.bot;
  }

  const bot = new Bot(env.TELEGRAM_BOT_TOKEN);

  // Handle all text messages
  bot.on('message:text', async (ctx) => {
    const chatId = ctx.chat?.id?.toString();
    console.log(`Message received from chat: ${chatId}`);

    // Check if chat is allowed (if restriction is configured)
    if (env.ALLOWED_CHAT_IDS) {
      const allowedIds = env.ALLOWED_CHAT_IDS.split(',').map((id) => id.trim());
      if (!chatId || !allowedIds.includes(chatId)) {
        console.log(`Blocked message from unauthorized chat: ${chatId}`);
        return; // Silently ignore
      }
    }

    const text = ctx.message.text;
    const url = extractDgiiUrl(text);

    if (url) {
      try {
        await handleDgiiUrl(ctx, url, env);
      } catch (error) {
        console.error('Error handling DGII URL:', error);
        await ctx.reply('❌ Ocurrió un error al procesar la factura\\. Por favor intenta de nuevo\\.', { parse_mode: 'MarkdownV2' });
      }
    }
    // Silently ignore messages without DGII URLs
  });

  cachedBot = { bot, token: env.TELEGRAM_BOT_TOKEN };
  return bot;
}

/**
 * Create webhook handler for Cloudflare Workers
 */
export function createWebhookHandler(env: Env) {
  const bot = getBot(env);
  return webhookCallback(bot, 'cloudflare-mod');
}
