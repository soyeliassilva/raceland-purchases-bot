import { Bot, Context, webhookCallback } from 'grammy';
import type { Env, Invoice, ExtractedInvoiceData } from './types.js';
import { MONTH_NAMES } from './types.js';
import { extractDgiiUrl, fetchInvoice, parseNumber } from './services/dgii.js';
import { addInvoiceToSheet, getAccessToken } from './services/sheets.js';
import { extractInvoiceData, parseReceiptDate } from './services/ocr.js';
import { getOrCreateReceiptFolder, uploadReceiptImage } from './services/drive.js';

// Bot instance cache (reuse across requests within same Worker instance)
let cachedBot: { bot: Bot; token: string } | null = null;

// Conversation state for photo upload confirmation (persists within single Worker invocation)
// Map<chatId, { data: ExtractedInvoiceData, timestamp: number, editingField?: string }>
const conversationState = new Map<string, {
  data: ExtractedInvoiceData;
  timestamp: number;
  editingField?: string;
  photoBuffer: ArrayBuffer;
}>();

// Session timeout (5 minutes)
const SESSION_TIMEOUT_MS = 5 * 60 * 1000;

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
 * Format confirmation dialog for extracted invoice data
 */
function formatConfirmationMessage(data: ExtractedInvoiceData): string {
  const lines = [
    '📄 *Datos Extraídos de la Factura*',
    '',
  ];

  if (data.rncEmisor) {
    lines.push(`🏢 RNC Emisor: \`${escapeMarkdown(data.rncEmisor)}\``);
  }
  if (data.rncComprador) {
    lines.push(`🛒 RNC Comprador: \`${escapeMarkdown(data.rncComprador)}\``);
  }
  if (data.ncf) {
    lines.push(`📄 NCF/ENCF: \`${escapeMarkdown(data.ncf)}\``);
  }
  if (data.fechaEmision) {
    lines.push(`📅 Fecha: \`${escapeMarkdown(data.fechaEmision)}\``);
  }
  if (data.itbis !== undefined) {
    lines.push(`📊 ITBIS: RD\\$\`${escapeMarkdown(data.itbis.toFixed(2))}\``);
  }
  if (data.montoTotal !== undefined) {
    lines.push(`💰 Total: RD\\$\`${escapeMarkdown(data.montoTotal.toFixed(2))}\``);
  }

  lines.push('', 'Por favor, verifica los datos\\. Puedes editar un campo seleccionando el número correspondiente\\.');

  return lines.join('\n');
}

/**
 * Get field label for editing
 */
function getFieldLabel(fieldIndex: number): string {
  const labels = {
    1: 'RNC Emisor',
    2: 'NCF/ENCF',
    3: 'Fecha',
    4: 'ITBIS',
    5: 'Monto Total',
  };
  return labels[fieldIndex as keyof typeof labels] || 'campo';
}

/**
 * Validate field input based on field type
 */
function validateFieldInput(fieldIndex: number, value: string): { valid: boolean; parsedValue?: string | number } {
  const trimmed = value.trim();

  switch (fieldIndex) {
    case 1: // RNC Emisor
      if (/^\d{9}$/.test(trimmed)) {
        return { valid: true, parsedValue: trimmed };
      }
      return { valid: false };

    case 2: // NCF/ENCF
      const upperNcf = trimmed.toUpperCase();
      if (/^[A-Z]\d{10}$/.test(upperNcf) || /^E\d{11}$/.test(upperNcf)) {
        return { valid: true, parsedValue: upperNcf };
      }
      return { valid: false };

    case 3: // Fecha
      const parsedDate = parseReceiptDate(trimmed);
      if (parsedDate) {
        const day = parsedDate.getUTCDate().toString().padStart(2, '0');
        const month = (parsedDate.getUTCMonth() + 1).toString().padStart(2, '0');
        const year = parsedDate.getUTCFullYear();
        return { valid: true, parsedValue: `${day}-${month}-${year}` };
      }
      return { valid: false };

    case 4: // ITBIS
    case 5: // Monto Total
      const num = parseNumber(trimmed);
      if (!isNaN(num) && num >= 0) {
        return { valid: true, parsedValue: num };
      }
      return { valid: false };

    default:
      return { valid: false };
  }
}

/**
 * Clean up expired conversation states
 */
function cleanupExpiredStates(): void {
  const now = Date.now();
  for (const [chatId, state] of conversationState.entries()) {
    if (now - state.timestamp > SESSION_TIMEOUT_MS) {
      conversationState.delete(chatId);
    }
  }
}

/**
 * Handle photo upload and OCR extraction
 */
async function handlePhotoUpload(ctx: Context, env: Env): Promise<void> {
  const chatId = ctx.chat?.id?.toString();
  if (!chatId) return;

  try {
    // Clean up expired states first
    cleanupExpiredStates();

    // Get the highest resolution photo
    const photos = ctx.message.photo;
    if (!photos || photos.length === 0) {
      await ctx.reply('❌ No se pudo obtener la foto\\. Por favor intenta de nuevo\\.', { parse_mode: 'MarkdownV2' });
      return;
    }

    const largestPhoto = photos[photos.length - 1];
    const file = await ctx.api.getFile(largestPhoto.file_id);

    // Download the photo
    const photoResponse = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${file.file_path}`);
    if (!photoResponse.ok) {
      throw new Error(`Failed to download photo: ${photoResponse.status}`);
    }

    const photoBuffer = await photoResponse.arrayBuffer();

    // Extract invoice data using OCR
    await ctx.reply('🔍 Analizando la factura\\. Esto puede tomar unos segundos...\\.\\.\\.', { parse_mode: 'MarkdownV2' });

    const extractedData = await extractInvoiceData(photoBuffer, env.AI);

    if (!extractedData) {
      await ctx.reply(
        '❌ No se pudieron extraer los datos de la factura\\. Por favor asegúrate de que la foto sea clara y todos los datos sean visibles\\. Intenta de nuevo o usa el método de URL\\.',
        { parse_mode: 'MarkdownV2' }
      );
      return;
    }

    // Validate buyer RNC if BUYER_RNC is configured
    if (env.BUYER_RNC && extractedData.rncComprador) {
      if (extractedData.rncComprador !== env.BUYER_RNC) {
        await ctx.reply(
          '⚠️ El RNC del comprador no coincide con el valor configurado\\. Por favor asegúrate de que la factura pertenezca a tu empresa o usa el método de URL\\.',
          { parse_mode: 'MarkdownV2' }
        );
        return;
      }
    }

    // Store conversation state
    conversationState.set(chatId, {
      data: extractedData,
      timestamp: Date.now(),
      photoBuffer,
    });

    // Build inline keyboard
    const keyboard = {
      inline_keyboard: [
        [
          { text: '[1] Editar RNC Emisor', callback_data: 'edit:1' },
          { text: '[2] Editar NCF/ENCF', callback_data: 'edit:2' },
        ],
        [
          { text: '[3] Editar Fecha', callback_data: 'edit:3' },
          { text: '[4] Editar ITBIS', callback_data: 'edit:4' },
        ],
        [
          { text: '[5] Editar Total', callback_data: 'edit:5' },
        ],
        [
          { text: '✅ Todo Correcto', callback_data: 'confirm' },
          { text: '❌ Cancelar', callback_data: 'cancel' },
        ],
      ],
    };

    await ctx.reply(formatConfirmationMessage(extractedData), {
      parse_mode: 'MarkdownV2',
      reply_markup: keyboard,
    });
  } catch (error) {
    console.error('Error handling photo upload:', error);
    await ctx.reply('❌ Ocurrió un error al procesar la foto\\. Por favor intenta de nuevo\\.', { parse_mode: 'MarkdownV2' });
    conversationState.delete(chatId);
  }
}

/**
 * Process confirmed invoice data (upload to Drive and save to Sheets)
 */
async function processConfirmedInvoice(ctx: Context, chatId: string, env: Env): Promise<void> {
  const state = conversationState.get(chatId);
  if (!state) return;

  const { data, photoBuffer } = state;

  try {
    await ctx.reply('💾 Guardando la factura...\\.\\.\\.', { parse_mode: 'MarkdownV2' });

    const accessToken = await getAccessToken(
      env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      env.GOOGLE_PRIVATE_KEY
    );

    // Parse date from extracted data
    const fechaEmision = parseReceiptDate(data.fechaEmision || '');
    if (!fechaEmision) {
      throw new Error('Invalid invoice date');
    }

    // Upload to Drive
    const year = fechaEmision.getUTCFullYear();
    const monthIndex = fechaEmision.getUTCMonth();
    const monthFolderId = await getOrCreateReceiptFolder(year, monthIndex, accessToken);

    const filename = `${data.ncf || 'factura'}.jpg`;
    const { webViewLink } = await uploadReceiptImage(photoBuffer, filename, monthFolderId, accessToken);

    // Create invoice object
    const invoice: Invoice = {
      rncEmisor: data.rncEmisor || '',
      rncComprador: data.rncComprador,
      encf: data.ncf || '',
      fechaEmision,
      montoTotal: data.montoTotal || 0,
      codigoSeguridad: null, // Photos don't have security codes
      vendorName: null, // Will be looked up
      itbis: data.itbis || null,
      status: 'Aceptado',
      source: 'photo',
      invoiceType: data.ncf?.startsWith('E') ? 'electronica' : 'papel',
      originalUrl: '', // Will use Drive URL instead
    };

    const username = ctx.from?.username ? `@${ctx.from.username}` : ctx.from?.first_name || `User ${ctx.from?.id}`;
    const result = await addInvoiceToSheet(invoice, username, env, webViewLink);

    if (result === 'duplicate') {
      await ctx.reply(formatDuplicateMessage(invoice.encf), { parse_mode: 'MarkdownV2' });
    } else {
      const month = MONTH_NAMES[monthIndex];
      const total = escapeMarkdown(invoice.montoTotal.toFixed(2));
      const itbis = invoice.itbis !== null ? escapeMarkdown(invoice.itbis.toFixed(2)) : 'N/A';

      await ctx.reply(
        [
          '✅ *Factura Agregada*',
          '',
          `📄 NCF/ENCF: \`${invoice.encf}\``,
          `🏢 Vendedor: \`${escapeMarkdown(invoice.rncEmisor)}\``,
          `💰 Total: RD\\$${total}`,
          `📊 ITBIS: RD\\$${itbis}`,
          '',
          `📁 Agregada a: ${escapeMarkdown(month)} ${year}`,
        ].join('\n'),
        { parse_mode: 'MarkdownV2' }
      );
    }
  } catch (error) {
    console.error('Error processing confirmed invoice:', error);
    await ctx.reply('❌ Ocurrió un error al guardar la factura\\. Por favor intenta de nuevo\\.', { parse_mode: 'MarkdownV2' });
  } finally {
    conversationState.delete(chatId);
  }
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

    // Check if user is editing a field
    const state = conversationState.get(chatId);
    if (state?.editingField) {
      const fieldIndex = parseInt(state.editingField, 10);
      const text = ctx.message.text?.trim();

      // Check for /cancel command
      if (text === '/cancel') {
        state.editingField = undefined;
        await ctx.reply('✏️ Edición cancelada\\.', { parse_mode: 'MarkdownV2' });
        await ctx.reply(formatConfirmationMessage(state.data), {
          parse_mode: 'MarkdownV2',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '[1] Editar RNC Emisor', callback_data: 'edit:1' },
                { text: '[2] Editar NCF/ENCF', callback_data: 'edit:2' },
              ],
              [
                { text: '[3] Editar Fecha', callback_data: 'edit:3' },
                { text: '[4] Editar ITBIS', callback_data: 'edit:4' },
              ],
              [
                { text: '[5] Editar Total', callback_data: 'edit:5' },
              ],
              [
                { text: '✅ Todo Correcto', callback_data: 'confirm' },
                { text: '❌ Cancelar', callback_data: 'cancel' },
              ],
            ],
          },
        });
        return;
      }

      // Validate and update field
      const validation = validateFieldInput(fieldIndex, text || '');
      if (validation.valid && validation.parsedValue !== undefined) {
        // Update the data
        switch (fieldIndex) {
          case 1:
            state.data.rncEmisor = validation.parsedValue as string;
            break;
          case 2:
            state.data.ncf = validation.parsedValue as string;
            break;
          case 3:
            state.data.fechaEmision = validation.parsedValue as string;
            break;
          case 4:
            state.data.itbis = validation.parsedValue as number;
            break;
          case 5:
            state.data.montoTotal = validation.parsedValue as number;
            break;
        }

        state.editingField = undefined;
        await ctx.reply('✅ Campo actualizado\\.', { parse_mode: 'MarkdownV2' });
        await ctx.reply(formatConfirmationMessage(state.data), {
          parse_mode: 'MarkdownV2',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '[1] Editar RNC Emisor', callback_data: 'edit:1' },
                { text: '[2] Editar NCF/ENCF', callback_data: 'edit:2' },
              ],
              [
                { text: '[3] Editar Fecha', callback_data: 'edit:3' },
                { text: '[4] Editar ITBIS', callback_data: 'edit:4' },
              ],
              [
                { text: '[5] Editar Total', callback_data: 'edit:5' },
              ],
              [
                { text: '✅ Todo Correcto', callback_data: 'confirm' },
                { text: '❌ Cancelar', callback_data: 'cancel' },
              ],
            ],
          },
        });
      } else {
        await ctx.reply(`❌ Valor inválido para ${getFieldLabel(fieldIndex)}\\. Por favor intenta de nuevo o escribe /cancel para abortar\\.`);
      }
      return;
    }

    // Check for DGII URL
    const url = extractDgiiUrl(text || '');

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

  // Handle photo uploads
  bot.on('message:photo', async (ctx) => {
    const chatId = ctx.chat?.id?.toString();

    // Check if chat is allowed (if restriction is configured)
    if (env.ALLOWED_CHAT_IDS) {
      const allowedIds = env.ALLOWED_CHAT_IDS.split(',').map((id) => id.trim());
      if (!chatId || !allowedIds.includes(chatId)) {
        console.log(`Blocked photo from unauthorized chat: ${chatId}`);
        return;
      }
    }

    try {
      await handlePhotoUpload(ctx, env);
    } catch (error) {
      console.error('Error handling photo upload:', error);
    }
  });

  // Handle callback queries (inline keyboard buttons)
  bot.on('callback_query:data', async (ctx) => {
    const chatId = ctx.callbackQuery?.message?.chat.id.toString();
    if (!chatId) return;

    // Clean up expired states
    cleanupExpiredStates();

    const state = conversationState.get(chatId);
    const data = ctx.callbackQuery.data;

    if (!state && data !== 'cancel') {
      await ctx.answerCallbackQuery({ text: 'Sesión expirada. Por favor envía la foto nuevamente.' });
      return;
    }

    if (data === 'confirm') {
      await ctx.answerCallbackQuery();
      await processConfirmedInvoice(ctx, chatId, env);
    } else if (data === 'cancel') {
      conversationState.delete(chatId);
      await ctx.answerCallbackQuery();
      await ctx.reply('❌ Operación cancelada\\.', { parse_mode: 'MarkdownV2' });
    } else if (data?.startsWith('edit:')) {
      const fieldIndex = parseInt(data.split(':')[1], 10);
      state!.editingField = fieldIndex.toString();
      await ctx.answerCallbackQuery();
      await ctx.reply(`✏️ Ingresa el nuevo valor para *${getFieldLabel(fieldIndex)}* \\(o escribe /cancel para abortar\\):`, { parse_mode: 'MarkdownV2' });
    } else {
      await ctx.answerCallbackQuery({ text: 'Acción no reconocida' });
    }
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
