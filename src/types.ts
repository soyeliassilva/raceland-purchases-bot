/**
 * Parsed URL parameters from DGII confirmation URL
 */
export interface DgiiUrlParams {
  rncEmisor: string;
  rncComprador: string;
  encf: string;
  fechaEmision: string; // dd-mm-yyyy format
  montoTotal: string;
  fechaFirma: string;
  codigoSeguridad: string;
}

/**
 * Data scraped from DGII confirmation page
 */
export interface DgiiScrapedData {
  vendorName: string; // Razón social emisor
  itbis: string; // Total de ITBIS
  status: string; // Estado (e.g., "Aceptado")
}

/**
 * Complete invoice data combining URL params and scraped data
 */
export interface Invoice {
  // From URL or photo OCR
  rncEmisor: string;
  rncComprador?: string; // Buyer RNC (for photo invoices)
  encf: string;
  fechaEmision: Date;
  montoTotal: number;
  propina: number; // Absolute legal tip amount, 0.00 when not present
  codigoSeguridad: string | null; // null for photo invoices
  // From scrape (optional - may be null if scrape fails)
  vendorName: string | null;
  itbis: number | null;
  status: string; // "Aceptado" or "Pendiente ITBIS"
  // Source tracking
  source: 'url' | 'photo';
  invoiceType?: 'electronica' | 'papel'; // Auto-detected from ENCF vs NCF format
  // Original URL for reference (empty for photos)
  originalUrl: string;
}

/**
 * Row format for Google Sheets
 * Columns: Fecha | Estado | ENCF | RNC Vendedor | Nombre Vendedor | Propina | ITBIS | Total | URL | Añadido Por | Añadido El
 */
export interface SheetRow {
  date: string;
  status: string; // "Aceptado" or "Pendiente ITBIS"
  encf: string;
  vendorRnc: string;
  vendorName: string;
  propina: string;
  itbis: string;
  total: string;
  url: string;
  addedBy: string;
  addedAt: string;
}

/**
 * OCR-extracted invoice data (before user confirmation)
 * All fields are optional to handle partial extraction
 */
export interface ExtractedInvoiceData {
  rncEmisor?: string;
  rncComprador?: string;
  ncf?: string;
  fechaEmision?: string;
  itbis?: number | string;
  montoTotal?: number | string;
  propina?: number | string;
  vendorName?: string;
}

/**
 * Cloudflare Workers AI binding type
 */
export interface Ai {
  run(model: string, input: AiInput): Promise<AiResponse>;
}

export interface AiMessageContentPart {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: { url: string };
}

export interface AiMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | AiMessageContentPart[];
}

export interface AiInput {
  messages: AiMessage[];
  max_tokens?: number;
  temperature?: number;
}

export interface AiResponse {
  response?: string | Record<string, unknown>;
}

/**
 * Per-tenant configuration for multi-company support
 */
export interface TenantConfig {
  name: string; // Company name (e.g., "Raiceland", "AlmaLogic")
  folderId?: string; // Google Drive folder ID (for both spreadsheets and receipt photos)
  buyerRnc?: string; // Buyer RNC for validation (photo invoices)
}

/**
 * Cloudflare Worker environment bindings
 */
export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  GOOGLE_SERVICE_ACCOUNT_EMAIL: string;
  GOOGLE_PRIVATE_KEY: string;
  SPREADSHEET_FOLDER_ID?: string;
  SHARED_FOLDER_ID?: string; // Google Drive shared folder ID for receipt uploads
  ALLOWED_CHAT_IDS?: string; // Comma-separated list of allowed chat IDs
  BUYER_RNC?: string; // Hardcoded buyer RNC for validation (photo invoices)
  TENANTS_CONFIG?: string; // JSON mapping chat IDs to TenantConfig (multi-tenant mode)
  AI: Ai; // Cloudflare Workers AI binding
}

/**
 * Month names constant (shared across modules)
 */
export const MONTH_NAMES = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
] as const;

/**
 * Default fetch timeout in milliseconds
 */
export const FETCH_TIMEOUT_MS = 15000;
