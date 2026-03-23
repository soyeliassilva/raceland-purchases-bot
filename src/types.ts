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
 * Columns: Fecha | Estado | ENCF | RNC Vendedor | Nombre Vendedor | ITBIS | Total | URL | Añadido Por | Añadido El
 */
export interface SheetRow {
  date: string;
  status: string; // "Aceptado" or "Pendiente ITBIS"
  encf: string;
  vendorRnc: string;
  vendorName: string;
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
  itbis?: number;
  montoTotal?: number;
}

/**
 * Cloudflare Workers AI binding type
 */
export type Ai = AiTextGeneration & AiImageClassification;

export interface AiTextGeneration {
  run(model: string, input: string | AiInput): Promise<AiResponse>;
}

export interface AiImageClassification {
  run(model: string, input: AiImageInput): Promise<AiResponse>;
}

export type AiInput =
  | string
  | {
      text?: string;
      image?: Array<{ image: string }>;
    };

export type AiImageInput = {
  image: Array<{ image: string }>;
  text?: string;
};

export interface AiResponse {
  success: boolean;
  data?: {
    response?: string;
  };
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
  ALLOWED_CHAT_IDS?: string; // Comma-separated list of allowed chat IDs
  BUYER_RNC?: string; // Hardcoded buyer RNC for validation (photo invoices)
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
