import type { ExtractedInvoiceData, Ai } from '../types.js';
import { FETCH_TIMEOUT_MS } from '../types.js';

const MODEL = '@cf/meta/llama-4-scout-17b-16e-instruct';

/**
 * Create AbortSignal with timeout
 */
function createTimeoutSignal(ms: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

/**
 * Validate RNC format (9 digits)
 */
function isValidRnc(rnc: string): boolean {
  return /^\d{9}$/.test(rnc.trim());
}

/**
 * Validate NCF/ENCF format
 * NCF: Letter + 10 digits (e.g., A0100100100)
 * ENCF: E + 11 digits (e.g., E310007157932)
 */
function isValidNcfOrEncf(value: string): boolean {
  const trimmed = value.trim().toUpperCase();
  // NCF format: 1 letter + 10 digits
  if (/^[A-Z]\d{10}$/.test(trimmed)) {
    return true;
  }
  // ENCF format: E + 11 digits
  if (/^E\d{11}$/.test(trimmed)) {
    return true;
  }
  return false;
}

/**
 * Detect invoice type from NCF/ENCF
 */
function detectInvoiceType(ncf: string): 'electronica' | 'papel' {
  return ncf.trim().toUpperCase().startsWith('E') ? 'electronica' : 'papel';
}

/**
 * Parse date from various formats
 * Tries: DD-MM-YYYY, DD/MM/YYYY, YYYY-MM-DD, DD/MM/YY, DD-MM-YY
 */
export function parseReceiptDate(dateStr: string): Date | null {
  const formats = [
    /^(\d{2})[-/](\d{2})[-/](\d{4})$/, // DD-MM-YYYY or DD/MM/YYYY
    /^(\d{4})[-/](\d{2})[-/](\d{2})$/, // YYYY-MM-DD or YYYY/MM/DD
    /^(\d{2})[-/](\d{2})[-/](\d{2})$/, // DD-MM-YY or DD/MM/YY
  ];

  for (const format of formats) {
    const match = dateStr.match(format);
    if (match) {
      let day: number, month: number, year: number;

      if (format === formats[0]) {
        // DD-MM-YYYY or DD/MM/YYYY
        day = parseInt(match[1], 10);
        month = parseInt(match[2], 10);
        year = parseInt(match[3], 10);
      } else if (format === formats[1]) {
        // YYYY-MM-DD or YYYY/MM/DD
        year = parseInt(match[1], 10);
        month = parseInt(match[2], 10);
        day = parseInt(match[3], 10);
      } else {
        // DD-MM-YY or DD/MM/YY - assume 20YY for years >= 00 and < 50
        day = parseInt(match[1], 10);
        month = parseInt(match[2], 10);
        let shortYear = parseInt(match[3], 10);
        year = shortYear >= 0 && shortYear < 50 ? 2000 + shortYear : 1900 + shortYear;
      }

      // Basic validation
      if (month < 1 || month > 12 || day < 1 || day > 31) {
        continue;
      }

      return new Date(Date.UTC(year, month - 1, day));
    }
  }

  console.error(`Could not parse date: ${dateStr}`);
  return null;
}

/**
 * Parse number handling both US (1,234.56) and Latin (1.234,56) formats
 */
function parseNumber(str: string): number {
  const cleaned = str.trim();
  const lastComma = cleaned.lastIndexOf(',');
  const lastDot = cleaned.lastIndexOf('.');

  if (lastComma > lastDot) {
    // Latin format: 1.234,56
    return parseFloat(cleaned.replace(/\./g, '').replace(',', '.'));
  } else {
    // US format: 1,234.56
    return parseFloat(cleaned.replace(/,/g, ''));
  }
}

/**
 * Extract invoice data from receipt photo using OCR
 */
export async function extractInvoiceData(
  imageBuffer: ArrayBuffer,
  ai: Ai
): Promise<ExtractedInvoiceData | null> {
  try {
    console.log('Starting OCR extraction...');

    // Convert ArrayBuffer to base64
    const bytes = new Uint8Array(imageBuffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const base64Image = btoa(binary);

    // Create OCR prompt
    const prompt = `Extract the following invoice data from this receipt image and return ONLY a JSON object (no markdown, no code blocks):
{
  "rncEmisor": "9-digit seller RNC",
  "rncComprador": "9-digit buyer RNC",
  "ncf": "NCF or ENCF number",
  "fechaEmision": "date in DD-MM-YYYY format",
  "itbis": "ITBIS amount as number",
  "montoTotal": "total amount as number"
}

If a field cannot be read, use null for its value.
For the NCF/ENCF field, extract exactly as shown (ENCF starts with E, NCF starts with a letter).
For dates, always use DD-MM-YYYY format.
For amounts, use numbers only (no currency symbols).`;

    // Call Cloudflare Workers AI
    const response = await ai.run(MODEL, {
      image: [{ image: base64Image }],
      text: prompt,
    } as unknown as Parameters<Ai['run']>[1]);

    if (!response.success || !response.data?.response) {
      console.error('OCR AI call failed');
      return null;
    }

    let jsonText = response.data.response.trim();

    // Remove markdown code blocks if present
    jsonText = jsonText.replace(/```json\n?/g, '').replace(/```\n?/g, '');

    console.log('OCR raw response:', jsonText);

    // Parse JSON response
    const extracted = JSON.parse(jsonText) as ExtractedInvoiceData;

    // Validate and normalize extracted data
    const result: ExtractedInvoiceData = {};

    // Validate RNC Emisor (critical field)
    if (extracted.rncEmisor && isValidRnc(extracted.rncEmisor)) {
      result.rncEmisor = extracted.rncEmisor.trim();
    }

    // Validate RNC Comprador (optional but good to have)
    if (extracted.rncComprador && isValidRnc(extracted.rncComprador)) {
      result.rncComprador = extracted.rncComprador.trim();
    }

    // Validate NCF/ENCF (critical field)
    if (extracted.ncf && isValidNcfOrEncf(extracted.ncf)) {
      result.ncf = extracted.ncf.trim().toUpperCase();
    }

    // Parse date
    if (extracted.fechaEmision) {
      const parsedDate = parseReceiptDate(extracted.fechaEmision);
      if (parsedDate) {
        const day = parsedDate.getUTCDate().toString().padStart(2, '0');
        const month = (parsedDate.getUTCMonth() + 1).toString().padStart(2, '0');
        const year = parsedDate.getUTCFullYear();
        result.fechaEmision = `${day}-${month}-${year}`;
      }
    }

    // Parse amounts
    if (extracted.itbis !== null && extracted.itbis !== undefined) {
      const itbis = typeof extracted.itbis === 'string'
        ? parseNumber(extracted.itbis)
        : extracted.itbis;
      if (!isNaN(itbis)) {
        result.itbis = itbis;
      }
    }

    if (extracted.montoTotal !== null && extracted.montoTotal !== undefined) {
      const total = typeof extracted.montoTotal === 'string'
        ? parseNumber(extracted.montoTotal)
        : extracted.montoTotal;
      if (!isNaN(total)) {
        result.montoTotal = total;
      }
    }

    // Check if critical fields are present
    if (!result.rncEmisor || !result.ncf || !result.montoTotal) {
      console.error('OCR missing critical fields:', {
        hasRncEmisor: !!result.rncEmisor,
        hasNcf: !!result.ncf,
        hasTotal: !!result.montoTotal,
      });
      return null;
    }

    console.log('OCR extraction successful:', result);
    return result;
  } catch (error) {
    console.error('Error extracting invoice data:', error);
    return null;
  }
}
