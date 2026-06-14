import type { ExtractedInvoiceData, Ai } from '../types.js';

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
 * Validate RNC (9 digits) or Cédula (11 digits) format
 */
function isValidRnc(rnc: string): boolean {
  return /^\d{9}$/.test(rnc.trim()) || /^\d{11}$/.test(rnc.trim());
}

/**
 * Validate NCF/ENCF format
 * NCF: Letter + 10 digits (e.g., A0100100100)
 * ENCF: E + 11 digits (e.g., E310007157932)
 */
function isValidNcfOrEncf(value: string): boolean {
  const trimmed = value.trim().toUpperCase();
  // NCF/ENCF: starts with a letter, followed by digits, 4-32 chars total
  return /^[A-Z]\d{3,31}$/.test(trimmed);
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
  ai: Ai,
  buyerRnc?: string
): Promise<ExtractedInvoiceData | null> {
  try {
    console.log('Starting OCR extraction...');

    // Convert ArrayBuffer to base64
    const bytes = new Uint8Array(imageBuffer);
    console.log(`Image size: ${bytes.byteLength} bytes`);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const base64Image = btoa(binary);
    console.log(`Base64 image length: ${base64Image.length} chars`);

    // Create OCR prompt
    const prompt = `Extract the following invoice data from this Dominican Republic receipt/invoice image and return ONLY a JSON object (no markdown, no code blocks):
{
  "rncEmisor": "seller/vendor RNC (usually at the top of the receipt, labeled RNC or near the business name)",
  "rncComprador": "buyer/client RNC (usually labeled RNC Comprador or Cliente)",
  "ncf": "NCF or ENCF number (starts with a letter like E or B)",
  "fechaEmision": "invoice date in DD-MM-YYYY format",
  "propina": "mandatory legal tip/service amount as number (look for Propina Legal, 10% de ley, Servicio Legal, or Ley 10%)",
  "itbis": "ITBIS tax amount as number",
  "montoTotal": "total amount as number"
}

IMPORTANT:
- The seller/vendor RNC (rncEmisor) is the business that issued the receipt. It appears at the TOP of the receipt near the business name/logo.
- The buyer RNC (rncComprador) is the client who received the goods/services. It usually appears lower, labeled "RNC Comprador" or "Cliente".
- RNC numbers may contain dashes (e.g., 101-71926-5). Remove all dashes and return digits only (e.g., 101719265).
- If a field cannot be read, use null for its value.
- For the NCF/ENCF field, extract exactly as shown (ENCF starts with E, NCF starts with a letter).
- For dates, always use DD-MM-YYYY format.
- For amounts, use numbers only (no currency symbols).
- For propina, return the absolute money amount, not the percentage. If no legal tip/service line appears, return 0.`;

    // Call Cloudflare Workers AI with OpenAI-compatible messages format
    const response = await ai.run(MODEL, {
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: {
                url: `data:image/jpeg;base64,${base64Image}`,
              },
            },
            {
              type: 'text',
              text: prompt,
            },
          ],
        },
      ],
    });

    console.log('AI response received:', JSON.stringify(response).substring(0, 500));

    if (!response.response) {
      console.error('OCR AI call failed - no response field:', JSON.stringify(response));
      return null;
    }

    // response.response can be a string or an already-parsed object
    let extracted: ExtractedInvoiceData;
    if (typeof response.response === 'string') {
      let jsonText = response.response.trim();
      // Remove markdown code blocks if present
      jsonText = jsonText.replace(/```json\n?/g, '').replace(/```\n?/g, '');
      console.log('OCR raw response (string):', jsonText);
      extracted = JSON.parse(jsonText) as ExtractedInvoiceData;
    } else {
      console.log('OCR raw response (object):', JSON.stringify(response.response));
      extracted = response.response as unknown as ExtractedInvoiceData;
    }

    // Validate and normalize extracted data
    const result: ExtractedInvoiceData = {};

    // Validate RNC Emisor (critical field) - strip dashes first
    const cleanRncEmisor = extracted.rncEmisor?.replace(/-/g, '').trim();
    if (cleanRncEmisor && isValidRnc(cleanRncEmisor)) {
      result.rncEmisor = cleanRncEmisor;
    }

    // Validate RNC Comprador (optional but good to have) - strip dashes first
    const cleanRncComprador = extracted.rncComprador?.replace(/-/g, '').trim();
    if (cleanRncComprador && isValidRnc(cleanRncComprador)) {
      result.rncComprador = cleanRncComprador;
    }

    // Validate NCF/ENCF (critical field) - strip leading zeros before the letter
    if (extracted.ncf) {
      const cleanNcf = extracted.ncf.trim().toUpperCase().replace(/^0+/, '');
      if (isValidNcfOrEncf(cleanNcf)) {
        result.ncf = cleanNcf;
      }
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
    if (extracted.propina !== null && extracted.propina !== undefined) {
      const propina = typeof extracted.propina === 'string'
        ? extracted.propina.includes('%')
          ? NaN
          : parseNumber(extracted.propina)
        : extracted.propina;
      result.propina = !isNaN(propina) && propina >= 0 ? propina : 0;
    } else {
      result.propina = 0;
    }

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

    const normalizedTotal = typeof result.montoTotal === 'number'
      ? result.montoTotal
      : result.montoTotal !== undefined
        ? parseNumber(result.montoTotal)
        : undefined;
    if (result.propina !== undefined && normalizedTotal !== undefined && result.propina > normalizedTotal) {
      result.propina = 0;
    }

    // Cross-check OCR propina against formula: propina = (total - itbis) / 11
    if (
      result.propina !== undefined && result.propina > 0 &&
      normalizedTotal !== undefined &&
      result.itbis !== undefined
    ) {
      const normalizedItbis = typeof result.itbis === 'number'
        ? result.itbis
        : parseNumber(result.itbis);
      if (!isNaN(normalizedItbis)) {
        const expectedPropina = Math.round(((normalizedTotal - normalizedItbis) / 11) * 100) / 100;
        if (Math.abs(result.propina - expectedPropina) > 1.0) {
          result.propinaMismatch = true;
        }
      }
    }

    // Fix swapped RNCs: if the "seller" RNC matches the known buyer, swap them
    if (buyerRnc && result.rncEmisor === buyerRnc) {
      console.log(`RNC swap: rncEmisor (${result.rncEmisor}) matches buyer RNC, swapping with rncComprador (${result.rncComprador || 'empty'})`);
      const temp = result.rncEmisor;
      result.rncEmisor = result.rncComprador;
      result.rncComprador = temp;
    }

    // Also handle case where buyer RNC appears as neither field but seller is missing
    if (buyerRnc && !result.rncComprador && result.rncEmisor !== buyerRnc) {
      result.rncComprador = buyerRnc;
    }

    // Check if minimum fields are present (NCF and total are essential; RNC can be edited by user)
    if (!result.ncf || !result.montoTotal) {
      console.error('OCR missing critical fields:', {
        hasRncEmisor: !!result.rncEmisor,
        hasNcf: !!result.ncf,
        hasTotal: !!result.montoTotal,
      });
      return null;
    }

    if (!result.rncEmisor) {
      console.log('OCR: seller RNC missing, user will need to provide it');
    }

    console.log('OCR extraction successful:', result);
    return result;
  } catch (error) {
    console.error('Error extracting invoice data:', error);
    return null;
  }
}
