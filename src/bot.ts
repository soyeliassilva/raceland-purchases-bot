import { Bot, Context, webhookCallback } from 'grammy';
import type { Env, Invoice, ExtractedInvoiceData, TenantConfig } from './types.js';
import { MONTH_NAMES } from './types.js';
import { extractDgiiUrl, fetchInvoice, parseNumber, lookupRncName } from './services/dgii.js';
import { addInvoiceToSheet, getAccessToken, findSpreadsheet, getMonthTotals } from './services/sheets.js';
import { extractInvoiceData, parseReceiptDate } from './services/ocr.js';
import { getOrCreateReceiptFolder, uploadReceiptImage } from './services/drive.js';

// Bot instance cache (reuse across requests within same Worker instance)
let cachedBot: { bot: Bot; token: string } | null = null;

// Parsed tenants config cache
let cachedTenantsConfig: Map<string, TenantConfig> | null = null;

/**
 * Parse TENANTS_CONFIG JSON into a Map of chatId -> TenantConfig
 */
function getTenantsConfig(env: Env): Map<string, TenantConfig> | null {
  if (!env.TENANTS_CONFIG) return null;
  if (cachedTenantsConfig) return cachedTenantsConfig;

  try {
    const parsed = JSON.parse(env.TENANTS_CONFIG) as Record<string, TenantConfig>;
    cachedTenantsConfig = new Map(Object.entries(parsed));
    return cachedTenantsConfig;
  } catch (error) {
    console.error('Failed to parse TENANTS_CONFIG:', error);
    return null;
  }
}

/**
 * Resolve tenant config for a given chat ID.
 * In multi-tenant mode: returns tenant config or null if chat is not configured.
 * In single-tenant mode: returns a config built from flat env vars.
 */
function resolveTenant(chatId: string, env: Env): TenantConfig | null {
  const tenants = getTenantsConfig(env);

  if (tenants) {
    // Multi-tenant mode: look up by chat ID
    return tenants.get(chatId) || null;
  }

  // Single-tenant mode: check ALLOWED_CHAT_IDS, then build config from env
  if (env.ALLOWED_CHAT_IDS) {
    const allowedIds = env.ALLOWED_CHAT_IDS.split(',').map((id) => id.trim());
    if (!allowedIds.includes(chatId)) return null;
  }

  return {
    name: 'Default',
    folderId: env.SPREADSHEET_FOLDER_ID || env.SHARED_FOLDER_ID,
    buyerRnc: env.BUYER_RNC,
  };
}

// Conversation state for photo upload confirmation (persists within single Worker invocation)
// Map<chatId, { data, timestamp, editingField?, photoBuffer, tenant }>
const conversationState = new Map<string, {
  data: ExtractedInvoiceData;
  timestamp: number;
  editingField?: string;
  photoBuffer: ArrayBuffer;
  tenant: TenantConfig;
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
  return text.replace(/[-_*[\]()~`>#+=|{}!.]/g, '\\$&');
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
    lines.push(`🏢 RNC Emisor: \`${data.rncEmisor}\``);
  } else {
    lines.push('⚠️ RNC Emisor: _No detectado \\- usa Editar RNC para ingresarlo_');
  }
  if (data.vendorName) {
    lines.push(`🏪 Vendedor: ${escapeMarkdown(data.vendorName)}`);
  }
  if (data.rncComprador) {
    lines.push(`🛒 RNC Comprador: \`${data.rncComprador}\``);
  }
  if (data.ncf) {
    lines.push(`📄 NCF/ENCF: \`${data.ncf}\``);
  }
  if (data.fechaEmision) {
    lines.push(`📅 Fecha: \`${data.fechaEmision}\``);
  }
  if (data.itbis !== undefined) {
    const itbisStr = data.itbis.toFixed(2);
    const escapedItbis = escapeMarkdown(itbisStr);
    console.log(`ITBIS DEBUG: original="${itbisStr}" escaped="${escapedItbis}"`);
    lines.push(`📊 ITBIS: RD\\$${escapedItbis}`);
  }
  if (data.montoTotal !== undefined) {
    const totalStr = data.montoTotal.toFixed(2);
    const escapedTotal = escapeMarkdown(totalStr);
    console.log(`TOTAL DEBUG: original="${totalStr}" escaped="${escapedTotal}"`);
    lines.push(`💰 Total: RD\\$${escapedTotal}`);
  }

  lines.push('', 'Por favor, verifica los datos\\. Puedes editar un campo seleccionando el número correspondiente\\.');

  const result = lines.join('\n');
  console.log('FULL MESSAGE DEBUG:', result);
  return result;
}

/**
 * Get field label for editing
 */
function getFieldLabel(fieldIndex: number): string {
  const labels = {
    1: 'RNC',
    2: 'NCF',
    3: 'Fecha',
    4: 'ITBIS',
    5: 'Total',
  };
  return labels[fieldIndex as keyof typeof labels] || 'campo';
}

/**
 * Validate field input based on field type
 */
function validateFieldInput(fieldIndex: number, value: string): { valid: boolean; parsedValue?: string | number } {
  const trimmed = value.trim();

  switch (fieldIndex) {
    case 1: // RNC Emisor (9 digits) or Cédula (11 digits)
      if (/^\d{9}$/.test(trimmed) || /^\d{11}$/.test(trimmed)) {
        return { valid: true, parsedValue: trimmed };
      }
      return { valid: false };

    case 2: // NCF/ENCF
      const upperNcf = trimmed.toUpperCase();
      if (/^[A-Z]\d{3,31}$/.test(upperNcf)) {
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
async function handlePhotoUpload(ctx: Context, env: Env, tenant: TenantConfig): Promise<void> {
  const chatId = ctx.chat?.id?.toString();
  if (!chatId) return;

  try {
    // Clean up expired states first
    cleanupExpiredStates();

    // Get the highest resolution photo
    const photos = ctx.message?.photo;
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
    await ctx.reply('🔍 Analizando la factura\\. Esto puede tomar unos segundos\\.\\.\\.\\.', { parse_mode: 'MarkdownV2' });

    const extractedData = await extractInvoiceData(photoBuffer, env.AI, tenant.buyerRnc);

    if (!extractedData) {
      await ctx.reply(
        '❌ No se pudieron extraer los datos de la factura\\. Por favor asegúrate de que la foto sea clara y todos los datos sean visibles\\. Intenta de nuevo o usa el método de URL\\.',
        { parse_mode: 'MarkdownV2' }
      );
      return;
    }

    // Validate buyer RNC if configured for this tenant
    if (tenant.buyerRnc && extractedData.rncComprador) {
      if (extractedData.rncComprador !== tenant.buyerRnc) {
        await ctx.reply(
          '⚠️ El RNC del comprador no coincide con el valor configurado\\. Por favor asegúrate de que la factura pertenezca a tu empresa o usa el método de URL\\.',
          { parse_mode: 'MarkdownV2' }
        );
        return;
      }
    }

    // Look up vendor name from RNC
    if (extractedData.rncEmisor) {
      const vendorName = await lookupRncName(extractedData.rncEmisor);
      if (vendorName) {
        extractedData.vendorName = vendorName;
      }
    }

    // Store conversation state (including tenant for later use in confirmation)
    conversationState.set(chatId, {
      data: extractedData,
      timestamp: Date.now(),
      photoBuffer,
      tenant,
    });

    // Build inline keyboard
    const keyboard = {
      inline_keyboard: [
        [
          { text: 'Editar RNC', callback_data: 'edit:1' },
          { text: 'Editar NCF', callback_data: 'edit:2' },
        ],
        [
          { text: 'Editar Fecha', callback_data: 'edit:3' },
          { text: 'Editar ITBIS', callback_data: 'edit:4' },
        ],
        [
          { text: 'Editar Total', callback_data: 'edit:5' },
        ],
        [
          { text: '✅ Todo Correcto', callback_data: 'confirm' },
          { text: '❌ Cancelar', callback_data: 'cancel' },
        ],
      ],
    };

    const message = formatConfirmationMessage(extractedData);
    console.log('=== ABOUT TO SEND MESSAGE ===');
    console.log('Message text:', message);
    console.log('Message length:', message.length);
    console.log('============================');

    await ctx.reply(message, {
      parse_mode: 'MarkdownV2',
      reply_markup: keyboard,
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    console.error('Error handling photo upload:', errorMsg);
    if (error instanceof Error && error.stack) {
      console.error('Stack:', error.stack);
    }
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

  const { data, photoBuffer, tenant } = state;

  try {
    // Require seller RNC for duplicate detection
    if (!data.rncEmisor) {
      await ctx.reply(
        '⚠️ El RNC del emisor es obligatorio\\. Usa el botón *Editar RNC* para agregarlo\\.',
        { parse_mode: 'MarkdownV2' }
      );
      return;
    }

    await ctx.reply('💾 Guardando la factura\\.\\.\\.', { parse_mode: 'MarkdownV2' });

    const accessToken = await getAccessToken(
      env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      env.GOOGLE_PRIVATE_KEY
    );

    // Parse date from extracted data
    const fechaEmision = parseReceiptDate(data.fechaEmision || '');
    if (!fechaEmision) {
      throw new Error('Invalid invoice date');
    }

    // Upload to Drive (use tenant-specific folder)
    const year = fechaEmision.getUTCFullYear();
    const monthIndex = fechaEmision.getUTCMonth();
    const monthFolderId = await getOrCreateReceiptFolder(year, monthIndex, accessToken, tenant.folderId);

    // Format filename as DD-MM-YYYY - NCF {ncf}.jpg
    const day = fechaEmision.getUTCDate().toString().padStart(2, '0');
    const month = (fechaEmision.getUTCMonth() + 1).toString().padStart(2, '0');
    const filename = `${day}-${month}-${year} - NCF ${data.ncf || 'desconocido'}.jpg`;
    const { webViewLink } = await uploadReceiptImage(photoBuffer, filename, monthFolderId, accessToken);

    // Create invoice object
    const invoice: Invoice = {
      rncEmisor: data.rncEmisor || '',
      rncComprador: data.rncComprador,
      encf: data.ncf || '',
      fechaEmision,
      montoTotal: data.montoTotal || 0,
      codigoSeguridad: null, // Photos don't have security codes
      vendorName: data.vendorName || null,
      itbis: data.itbis || null,
      status: 'Aceptado',
      source: 'photo',
      invoiceType: data.ncf?.startsWith('E') ? 'electronica' : 'papel',
      originalUrl: '', // Will use Drive URL instead
    };

    const username = ctx.from?.username ? `@${ctx.from.username}` : ctx.from?.first_name || `User ${ctx.from?.id}`;
    const result = await addInvoiceToSheet(invoice, username, env, webViewLink, tenant.folderId);

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
          `🏢 Vendedor: \`${invoice.rncEmisor}\``,
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
  env: Env,
  tenant: TenantConfig
): Promise<void> {
  const result = await fetchInvoice(url);

  if (result === 'invalid_url') {
    // Silently ignore invalid URLs
    return;
  }

  // Validate buyer RNC if configured for this tenant
  if (tenant.buyerRnc && result.rncComprador && result.rncComprador !== tenant.buyerRnc) {
    const buyerName = await lookupRncName(result.rncComprador);
    const displayName = buyerName
      ? `${escapeMarkdown(buyerName)} \\(\`${result.rncComprador}\`\\)`
      : `\`${result.rncComprador}\``;
    await ctx.reply(
      `⚠️ Esta factura fue emitida a nombre de ${displayName}, no corresponde a este grupo\\.`,
      { parse_mode: 'MarkdownV2' }
    );
    return;
  }

  const username = getUsername(ctx);

  // Always add to sheet (even if ITBIS is pending)
  const sheetResult = await addInvoiceToSheet(result, username, env, undefined, tenant.folderId);

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

  // Handle /resumen command — show monthly ITBIS and Total summary
  bot.command('resumen', async (ctx) => {
    const chatId = ctx.chat?.id?.toString();
    if (!chatId) return;

    const tenant = resolveTenant(chatId, env);
    if (!tenant) return;

    // Parse arguments: /resumen [month] [year]
    const args = ctx.match?.toString().trim().split(/\s+/) || [];
    const now = new Date();
    let monthIndex: number;
    let year: number;

    if (args.length === 0 || args[0] === '') {
      // No args — use current month
      monthIndex = now.getUTCMonth();
      year = now.getUTCFullYear();
    } else {
      // Parse month (name or number)
      const monthArg = args[0].toLowerCase();
      const monthByName = MONTH_NAMES.findIndex(
        (m) => m.toLowerCase().startsWith(monthArg)
      );
      if (monthByName >= 0) {
        monthIndex = monthByName;
      } else {
        const monthNum = parseInt(monthArg, 10);
        if (monthNum >= 1 && monthNum <= 12) {
          monthIndex = monthNum - 1;
        } else {
          await ctx.reply('❌ Mes no válido\\. Usa un nombre \\(Enero, Feb\\.\\.\\.\\) o número \\(1\\-12\\)\\.', { parse_mode: 'MarkdownV2' });
          return;
        }
      }

      // Parse optional year
      if (args.length >= 2) {
        year = parseInt(args[1], 10);
        if (isNaN(year) || year < 2000 || year > 2100) {
          await ctx.reply('❌ Año no válido\\.', { parse_mode: 'MarkdownV2' });
          return;
        }
      } else {
        year = now.getUTCFullYear();
      }
    }

    try {
      const accessToken = await getAccessToken(
        env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        env.GOOGLE_PRIVATE_KEY
      );

      const folderId = tenant.folderId || env.SPREADSHEET_FOLDER_ID;
      const spreadsheetId = await findSpreadsheet(year, accessToken, folderId);

      if (!spreadsheetId) {
        const sheetName = MONTH_NAMES[monthIndex];
        await ctx.reply(
          `📊 *Resumen de ${escapeMarkdown(sheetName)} ${year}*\n\nNo hay facturas registradas\\.`,
          { parse_mode: 'MarkdownV2' }
        );
        return;
      }

      const sheetName = MONTH_NAMES[monthIndex];
      const totals = await getMonthTotals(spreadsheetId, sheetName, accessToken);

      if (!totals || totals.rowCount === 0) {
        await ctx.reply(
          `📊 *Resumen de ${escapeMarkdown(sheetName)} ${year}*\n\nNo hay facturas registradas\\.`,
          { parse_mode: 'MarkdownV2' }
        );
        return;
      }

      const formatCurrency = (n: number) => n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
      const itbisStr = escapeMarkdown(formatCurrency(totals.totalItbis));
      const totalStr = escapeMarkdown(formatCurrency(totals.totalAmount));

      await ctx.reply(
        [
          `📊 *Resumen de ${escapeMarkdown(sheetName)} ${year}*`,
          '',
          `📄 Facturas: ${totals.rowCount}`,
          `📊 ITBIS Total: RD\\$${itbisStr}`,
          `💰 Monto Total: RD\\$${totalStr}`,
        ].join('\n'),
        { parse_mode: 'MarkdownV2' }
      );
    } catch (error) {
      console.error('Error fetching month totals:', error);
      await ctx.reply('❌ Ocurrió un error al consultar los totales\\.', { parse_mode: 'MarkdownV2' });
    }
  });

  // Handle all text messages
  bot.on('message:text', async (ctx) => {
    const chatId = ctx.chat?.id?.toString();
    console.log(`Message received from chat: ${chatId}`);

    if (!chatId) return;

    // Check if user is editing a field (tenant already resolved when photo was sent)
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
                { text: 'Editar Total', callback_data: 'edit:5' },
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
                { text: 'Editar Total', callback_data: 'edit:5' },
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
    const url = extractDgiiUrl(ctx.message.text || '');

    if (url) {
      // Resolve tenant for this chat
      const tenant = resolveTenant(chatId, env);
      if (!tenant) {
        console.log(`Blocked message from unauthorized chat: ${chatId}`);
        return;
      }

      try {
        await handleDgiiUrl(ctx, url, env, tenant);
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
    if (!chatId) return;

    // Resolve tenant for this chat
    const tenant = resolveTenant(chatId, env);
    if (!tenant) {
      console.log(`Blocked photo from unauthorized chat: ${chatId}`);
      return;
    }

    try {
      await handlePhotoUpload(ctx, env, tenant);
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
