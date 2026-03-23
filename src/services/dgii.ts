import type { DgiiUrlParams, DgiiScrapedData, Invoice } from '../types.js';
import { FETCH_TIMEOUT_MS } from '../types.js';

const DGII_URL_PATTERN = /ecf\.dgii\.gov\.do/i;
const NOT_FOUND_MESSAGE = 'No fue encontrada la factura';

/**
 * Create AbortSignal with timeout
 */
function createTimeoutSignal(ms: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

/**
 * Case-insensitive URLSearchParams getter
 */
function getParamCaseInsensitive(params: URLSearchParams, key: string): string | null {
  const lowerKey = key.toLowerCase();
  for (const [k, v] of params.entries()) {
    if (k.toLowerCase() === lowerKey) {
      return v;
    }
  }
  return null;
}

/**
 * Parse DGII confirmation URL and extract parameters
 */
export function parseUrl(url: string): DgiiUrlParams | null {
  try {
    if (!DGII_URL_PATTERN.test(url)) {
      return null;
    }

    const parsed = new URL(url);
    const params = parsed.searchParams;

    const rncEmisor = getParamCaseInsensitive(params, 'RncEmisor');
    const rncComprador = getParamCaseInsensitive(params, 'RncComprador');
    const encf = getParamCaseInsensitive(params, 'ENCF');
    const fechaEmision = getParamCaseInsensitive(params, 'FechaEmision');
    const montoTotal = getParamCaseInsensitive(params, 'MontoTotal');
    const fechaFirma = getParamCaseInsensitive(params, 'FechaFirma');
    const codigoSeguridad = getParamCaseInsensitive(params, 'CodigoSeguridad');

    // All required params must be present
    if (!rncEmisor || !rncComprador || !encf || !fechaEmision || !montoTotal || !fechaFirma || !codigoSeguridad) {
      return null;
    }

    return {
      rncEmisor,
      rncComprador,
      encf,
      fechaEmision,
      montoTotal,
      fechaFirma,
      codigoSeguridad,
    };
  } catch (error) {
    console.error('Error parsing DGII URL:', error);
    return null;
  }
}

/**
 * Parse dd-mm-yyyy date format to Date object (treated as UTC)
 * Returns null if format is invalid
 */
export function parseDgiiDate(dateStr: string): Date | null {
  // Validate format: dd-mm-yyyy
  const match = dateStr.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (!match) {
    console.error(`Invalid date format: ${dateStr}, expected dd-mm-yyyy`);
    return null;
  }

  const day = parseInt(match[1], 10);
  const month = parseInt(match[2], 10);
  const year = parseInt(match[3], 10);

  // Basic validation
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    console.error(`Invalid date values: day=${day}, month=${month}, year=${year}`);
    return null;
  }

  return new Date(Date.UTC(year, month - 1, day));
}

/**
 * Decode HTML entities (comprehensive)
 */
function decodeHtmlEntities(text: string): string {
  return text
    // Named entities
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    // Spanish vowels with accents (lowercase)
    .replace(/&aacute;/gi, 'á')
    .replace(/&eacute;/gi, 'é')
    .replace(/&iacute;/gi, 'í')
    .replace(/&oacute;/gi, 'ó')
    .replace(/&uacute;/gi, 'ú')
    // Spanish vowels with accents (uppercase)
    .replace(/&Aacute;/g, 'Á')
    .replace(/&Eacute;/g, 'É')
    .replace(/&Iacute;/g, 'Í')
    .replace(/&Oacute;/g, 'Ó')
    .replace(/&Uacute;/g, 'Ú')
    // Ñ
    .replace(/&ntilde;/gi, 'ñ')
    .replace(/&Ntilde;/g, 'Ñ')
    // Ü
    .replace(/&uuml;/gi, 'ü')
    .replace(/&Uuml;/g, 'Ü')
    // Numeric entities (decimal)
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
    // Numeric entities (hex)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

/**
 * Extract value from HTML table row using label
 * Matches: <th...>LABEL</th> followed by <td...>VALUE</td>
 */
function extractTableValue(html: string, labelPatterns: string[]): string | null {
  // Decode HTML entities first so patterns can match accented characters
  const decodedHtml = decodeHtmlEntities(html);

  for (const label of labelPatterns) {
    // Match <th>label</th> followed by <td>value</td>
    // The label must be the main content of the th (not partial match)
    const pattern = new RegExp(
      `<th[^>]*>\\s*${label}\\s*</th>\\s*<td[^>]*>\\s*([\\s\\S]*?)\\s*</td>`,
      'i'
    );
    const match = decodedHtml.match(pattern);
    if (match && match[1]) {
      return match[1].trim();
    }
  }
  return null;
}

/**
 * Parse number handling both US (1,234.56) and Latin (1.234,56) formats
 */
export function parseNumber(str: string): number {
  // Remove whitespace
  const cleaned = str.trim();

  // Detect format by checking last separator
  const lastComma = cleaned.lastIndexOf(',');
  const lastDot = cleaned.lastIndexOf('.');

  if (lastComma > lastDot) {
    // Latin format: 1.234,56 -> comma is decimal separator
    return parseFloat(cleaned.replace(/\./g, '').replace(',', '.'));
  } else {
    // US format: 1,234.56 -> dot is decimal separator
    return parseFloat(cleaned.replace(/,/g, ''));
  }
}

/**
 * Scrape DGII confirmation page for invoice data
 */
export async function scrapePage(url: string): Promise<DgiiScrapedData | null> {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'es-DO,es;q=0.9,en;q=0.8',
      },
      signal: createTimeoutSignal(FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      console.error(`DGII page fetch failed: ${response.status}`);
      return null;
    }

    const html = await response.text();

    // Check for "invoice not found" message
    if (html.includes(NOT_FOUND_MESSAGE)) {
      return null;
    }

    // Extract fields from HTML table
    const vendorName = extractTableValue(html, [
      'Raz[oó]n\\s*social\\s*emisor',
      'Nombre\\s*emisor',
      'Emisor',
    ]);

    const itbis = extractTableValue(html, [
      'Total\\s*de\\s*ITBIS',
      'ITBIS',
      'Total\\s*ITBIS',
    ]);

    const status = extractTableValue(html, [
      'Estado',
      'Estatus',
    ]);

    // Debug logging for scraping
    console.log('DGII scrape results:', { vendorName, itbis, status });

    // ITBIS is the most important field
    if (!itbis) {
      console.error('Could not extract ITBIS from DGII page');
      console.log('HTML snippet:', html.substring(0, 2000));
      return null;
    }

    return {
      vendorName: vendorName || '',
      itbis,
      status: status || 'Aceptado',
    };
  } catch (error) {
    console.error('Error scraping DGII page:', error);
    return null;
  }
}

const DGII_FORM_URL = 'https://dgii.gov.do/app/WebApps/ConsultasWeb2/ConsultasWeb/consultas/ncf.aspx';

/**
 * Extract ASP.NET hidden fields from HTML
 */
function extractAspNetFields(html: string): Record<string, string> {
  const fields: Record<string, string> = {};

  const fieldNames = ['__VIEWSTATE', '__VIEWSTATEGENERATOR', '__EVENTVALIDATION', '__EVENTTARGET', '__EVENTARGUMENT'];

  for (const name of fieldNames) {
    const pattern = new RegExp(`name="${name}"[^>]*value="([^"]*)"`, 'i');
    const match = html.match(pattern);
    if (match) {
      fields[name] = match[1];
    }
  }

  return fields;
}

/**
 * Scrape DGII via form submission (alternative method)
 * This submits to the NCF lookup form which may be more reliable
 */
async function scrapeViaForm(
  rncEmisor: string,
  encf: string,
  rncComprador: string,
  codigoSeguridad: string
): Promise<DgiiScrapedData | null> {
  try {
    console.log('Trying form-based DGII scrape...');

    // Step 1: GET the form page to extract ASP.NET hidden fields
    const getResponse = await fetch(DGII_FORM_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      signal: createTimeoutSignal(FETCH_TIMEOUT_MS),
    });

    if (!getResponse.ok) {
      console.error(`Form GET failed: ${getResponse.status}`);
      return null;
    }

    const formHtml = await getResponse.text();
    const aspNetFields = extractAspNetFields(formHtml);

    if (!aspNetFields.__VIEWSTATE) {
      console.error('Could not extract __VIEWSTATE from form');
      return null;
    }

    // Step 2: POST the form with our data
    const formData = new URLSearchParams();

    // Add ASP.NET hidden fields
    for (const [key, value] of Object.entries(aspNetFields)) {
      formData.append(key, value);
    }

    // Add our form fields
    formData.append('ctl00$cphMain$txtRNC', rncEmisor);
    formData.append('ctl00$cphMain$txtNCF', encf);
    formData.append('ctl00$cphMain$txtRncComprador', rncComprador);
    formData.append('ctl00$cphMain$txtCodigoSeg', codigoSeguridad.substring(0, 6)); // First 6 chars
    formData.append('ctl00$cphMain$btnConsultar', 'Buscar');

    const postResponse = await fetch(DGII_FORM_URL, {
      method: 'POST',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      body: formData.toString(),
      signal: createTimeoutSignal(FETCH_TIMEOUT_MS),
    });

    if (!postResponse.ok) {
      console.error(`Form POST failed: ${postResponse.status}`);
      return null;
    }

    const resultHtml = await postResponse.text();

    // Extract data from result page
    const decodedHtml = decodeHtmlEntities(resultHtml);

    // Look for the results table - DGII form returns data in a similar table format
    const vendorName = extractTableValue(resultHtml, [
      'Raz[oó]n\\s*Social',
      'Nombre\\s*o\\s*Raz[oó]n\\s*Social',
    ]);

    const itbis = extractTableValue(resultHtml, [
      'Total\\s*ITBIS',
      'ITBIS\\s*Facturado',
      'Monto\\s*ITBIS',
      'ITBIS',
    ]);

    const status = extractTableValue(resultHtml, [
      'Estado',
      'Estatus',
    ]);

    console.log('Form scrape results:', { vendorName, itbis, status });

    // For form scrape, we mainly care about ITBIS
    if (itbis) {
      return {
        vendorName: vendorName || '',
        itbis,
        status: status || 'Aceptado',
      };
    }

    console.log('Form result HTML snippet:', resultHtml.substring(0, 3000));
    return null;
  } catch (error) {
    console.error('Error in form-based scrape:', error);
    return null;
  }
}

/**
 * Fetch complete invoice data from DGII URL
 * Always returns an Invoice (never 'not_available') - if scraping fails, status = "Pendiente ITBIS"
 */
export async function fetchInvoice(
  url: string
): Promise<Invoice | 'invalid_url'> {
  const params = parseUrl(url);
  if (!params) {
    return 'invalid_url';
  }

  const fechaEmision = parseDgiiDate(params.fechaEmision);
  if (!fechaEmision) {
    console.error(`Invalid date in URL: ${params.fechaEmision}`);
    return 'invalid_url';
  }

  // Try direct page scrape first
  let scraped = await scrapePage(url);

  // If direct scrape fails, try form-based approach
  if (!scraped) {
    console.log('Direct scrape failed, trying form-based approach...');
    scraped = await scrapeViaForm(
      params.rncEmisor,
      params.encf,
      params.rncComprador,
      params.codigoSeguridad
    );
  }

  // Always return an invoice - if scraping failed, mark as "Pendiente ITBIS"
  if (!scraped) {
    console.log('All scraping methods failed, saving with Pendiente ITBIS status');
    return {
      rncEmisor: params.rncEmisor,
      encf: params.encf,
      fechaEmision,
      montoTotal: parseNumber(params.montoTotal),
      codigoSeguridad: params.codigoSeguridad,
      vendorName: null,
      itbis: null,
      status: 'Pendiente ITBIS',
      originalUrl: url,
    };
  }

  return {
    rncEmisor: params.rncEmisor,
    encf: params.encf,
    fechaEmision,
    montoTotal: parseNumber(params.montoTotal),
    codigoSeguridad: params.codigoSeguridad,
    vendorName: scraped.vendorName || null,
    itbis: parseNumber(scraped.itbis),
    status: scraped.status,
    originalUrl: url,
  };
}

/**
 * Extract DGII URL from message text
 */
export function extractDgiiUrl(text: string): string | null {
  // Match URL but exclude trailing punctuation
  const urlPattern = /https?:\/\/ecf\.dgii\.gov\.do[^\s]*[^\s.,;:!?\)>\]]/i;
  const match = text.match(urlPattern);
  return match ? match[0] : null;
}
