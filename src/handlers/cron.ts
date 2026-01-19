import type { Env } from '../types.js';
import { MONTH_NAMES, FETCH_TIMEOUT_MS } from '../types.js';
import { getAccessToken } from '../services/sheets.js';

const DGII_FORM_URL = 'https://dgii.gov.do/app/WebApps/ConsultasWeb2/ConsultasWeb/consultas/ncf.aspx';

/**
 * Create AbortSignal with timeout
 */
function createTimeoutSignal(ms: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

/**
 * Decode HTML entities
 */
function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

/**
 * Extract ITBIS from DGII form response
 */
function extractItbis(html: string): string | null {
  const decodedHtml = decodeHtmlEntities(html);
  const patterns = [
    /<th[^>]*>\s*Total\s*ITBIS\s*<\/th>\s*<td[^>]*>\s*([\s\S]*?)\s*<\/td>/i,
    /<th[^>]*>\s*ITBIS\s*Facturado\s*<\/th>\s*<td[^>]*>\s*([\s\S]*?)\s*<\/td>/i,
    /<th[^>]*>\s*Monto\s*ITBIS\s*<\/th>\s*<td[^>]*>\s*([\s\S]*?)\s*<\/td>/i,
  ];

  for (const pattern of patterns) {
    const match = decodedHtml.match(pattern);
    if (match && match[1]) {
      return match[1].trim();
    }
  }
  return null;
}

/**
 * Extract status from DGII form response
 */
function extractStatus(html: string): string | null {
  const decodedHtml = decodeHtmlEntities(html);
  const pattern = /<th[^>]*>\s*Estado\s*<\/th>\s*<td[^>]*>\s*([\s\S]*?)\s*<\/td>/i;
  const match = decodedHtml.match(pattern);
  return match ? match[1].trim() : null;
}

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
 * Try to scrape ITBIS via form submission
 */
async function scrapeItbisViaForm(
  rncEmisor: string,
  encf: string,
  codigoSeguridad: string
): Promise<{ itbis: string; status: string } | null> {
  try {
    // GET the form page first
    const getResponse = await fetch(DGII_FORM_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html',
      },
      signal: createTimeoutSignal(FETCH_TIMEOUT_MS),
    });

    if (!getResponse.ok) return null;

    const formHtml = await getResponse.text();
    const aspNetFields = extractAspNetFields(formHtml);
    if (!aspNetFields.__VIEWSTATE) return null;

    // POST the form
    const formData = new URLSearchParams();
    for (const [key, value] of Object.entries(aspNetFields)) {
      formData.append(key, value);
    }
    formData.append('ctl00$cphMain$txtRNC', rncEmisor);
    formData.append('ctl00$cphMain$txtNCF', encf);
    formData.append('ctl00$cphMain$txtRncComprador', ''); // Not needed for lookup
    formData.append('ctl00$cphMain$txtCodigoSeg', codigoSeguridad.substring(0, 6));
    formData.append('ctl00$cphMain$btnConsultar', 'Buscar');

    const postResponse = await fetch(DGII_FORM_URL, {
      method: 'POST',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formData.toString(),
      signal: createTimeoutSignal(FETCH_TIMEOUT_MS),
    });

    if (!postResponse.ok) return null;

    const resultHtml = await postResponse.text();
    const itbis = extractItbis(resultHtml);
    const status = extractStatus(resultHtml);

    if (itbis) {
      return { itbis, status: status || 'Aceptado' };
    }
    return null;
  } catch (error) {
    console.error('Error scraping ITBIS via form:', error);
    return null;
  }
}

/**
 * Parse URL to extract parameters
 */
function parseInvoiceUrl(url: string): { rncEmisor: string; encf: string; codigoSeguridad: string } | null {
  try {
    const parsed = new URL(url);
    const rncEmisor = parsed.searchParams.get('RncEmisor');
    const encf = parsed.searchParams.get('ENCF');
    const codigoSeguridad = parsed.searchParams.get('CodigoSeguridad');

    if (!rncEmisor || !encf || !codigoSeguridad) return null;
    return { rncEmisor, encf, codigoSeguridad };
  } catch {
    return null;
  }
}

/**
 * Get all spreadsheets in the folder for the current and previous year
 */
async function getYearSpreadsheets(
  accessToken: string,
  folderId?: string
): Promise<Array<{ id: string; name: string }>> {
  const currentYear = new Date().getUTCFullYear();
  const years = [currentYear, currentYear - 1];
  const spreadsheets: Array<{ id: string; name: string }> = [];

  for (const year of years) {
    let query = `name='${year}' and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false`;
    if (folderId) {
      query += ` and '${folderId}' in parents`;
    }

    const response = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name)&supportsAllDrives=true&includeItemsFromAllDrives=true`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: createTimeoutSignal(FETCH_TIMEOUT_MS),
      }
    );

    if (response.ok) {
      const data = await response.json() as { files: Array<{ id: string; name: string }> };
      if (data.files?.length > 0) {
        spreadsheets.push(...data.files);
      }
    }
  }

  return spreadsheets;
}

/**
 * Find rows with "Pendiente ITBIS" status in a spreadsheet
 */
async function findPendingRows(
  spreadsheetId: string,
  accessToken: string
): Promise<Array<{ sheetName: string; rowIndex: number; url: string; encf: string }>> {
  const pending: Array<{ sheetName: string; rowIndex: number; url: string; encf: string }> = [];

  // Get all sheet names
  const metaResponse = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties.title`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: createTimeoutSignal(FETCH_TIMEOUT_MS),
    }
  );

  if (!metaResponse.ok) return pending;

  const metaData = await metaResponse.json() as { sheets: Array<{ properties: { title: string } }> };

  for (const sheet of metaData.sheets) {
    const sheetName = sheet.properties.title;

    // Get all data from this sheet
    // Columns: A=Fecha, B=Estado, C=ENCF, D=RNC, E=Nombre, F=ITBIS, G=Total, H=URL
    const dataResponse = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(sheetName)}!A:H`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: createTimeoutSignal(FETCH_TIMEOUT_MS),
      }
    );

    if (!dataResponse.ok) continue;

    const data = await dataResponse.json() as { values?: string[][] };
    if (!data.values) continue;

    // Skip header row, find rows with "Pendiente ITBIS" in column B (index 1)
    for (let i = 1; i < data.values.length; i++) {
      const row = data.values[i];
      if (row[1] === 'Pendiente ITBIS' && row[7]) { // Column B = status, Column H = URL
        pending.push({
          sheetName,
          rowIndex: i + 1, // 1-indexed for Sheets API
          url: row[7],
          encf: row[2] || '',
        });
      }
    }
  }

  return pending;
}

/**
 * Update a row with ITBIS data
 */
async function updateRowWithItbis(
  spreadsheetId: string,
  sheetName: string,
  rowIndex: number,
  itbis: string,
  status: string,
  accessToken: string
): Promise<boolean> {
  // Update columns B (status) and F (ITBIS)
  const response = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values:batchUpdate`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        valueInputOption: 'RAW',
        data: [
          {
            range: `${sheetName}!B${rowIndex}`,
            values: [[status]],
          },
          {
            range: `${sheetName}!F${rowIndex}`,
            values: [[itbis]],
          },
        ],
      }),
      signal: createTimeoutSignal(FETCH_TIMEOUT_MS),
    }
  );

  return response.ok;
}

/**
 * Handle scheduled cron trigger
 * Searches for "Pendiente ITBIS" rows and tries to scrape ITBIS for each
 */
export async function handleCron(env: Env): Promise<void> {
  console.log('Starting cron job: processing pending ITBIS rows');

  const accessToken = await getAccessToken(
    env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    env.GOOGLE_PRIVATE_KEY
  );

  // Get spreadsheets for current and previous year
  const spreadsheets = await getYearSpreadsheets(accessToken, env.SPREADSHEET_FOLDER_ID);

  if (spreadsheets.length === 0) {
    console.log('No spreadsheets found');
    return;
  }

  let totalPending = 0;
  let totalUpdated = 0;

  for (const spreadsheet of spreadsheets) {
    console.log(`Checking spreadsheet: ${spreadsheet.name}`);

    const pendingRows = await findPendingRows(spreadsheet.id, accessToken);
    totalPending += pendingRows.length;

    for (const row of pendingRows) {
      console.log(`Processing pending row: ${row.encf}`);

      const params = parseInvoiceUrl(row.url);
      if (!params) {
        console.log(`Could not parse URL for ${row.encf}`);
        continue;
      }

      const result = await scrapeItbisViaForm(params.rncEmisor, params.encf, params.codigoSeguridad);

      if (result) {
        const updated = await updateRowWithItbis(
          spreadsheet.id,
          row.sheetName,
          row.rowIndex,
          result.itbis,
          result.status,
          accessToken
        );

        if (updated) {
          console.log(`Updated ${row.encf} with ITBIS: ${result.itbis}`);
          totalUpdated++;
        }
      } else {
        console.log(`Still could not get ITBIS for ${row.encf}`);
      }
    }
  }

  console.log(`Cron job completed. Pending: ${totalPending}, Updated: ${totalUpdated}`);
}
