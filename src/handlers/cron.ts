import type { Env, TenantConfig } from '../types.js';
import { FETCH_TIMEOUT_MS } from '../types.js';
import { getAccessToken } from '../services/sheets.js';
import { findFolder } from '../services/drive.js';
import { parseUrl, scrapePage, scrapeViaForm, parseNumber } from '../services/dgii.js';

function createTimeoutSignal(ms: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

/**
 * Get "Reporte" spreadsheets inside year folders for the current and previous year
 * Structure: rootFolder/{YYYY}/Reporte
 */
async function getYearSpreadsheets(
  accessToken: string,
  folderId?: string
): Promise<Array<{ id: string; name: string }>> {
  const currentYear = new Date().getUTCFullYear();
  const years = [currentYear, currentYear - 1];
  const spreadsheets: Array<{ id: string; name: string }> = [];

  for (const year of years) {
    // First find the year folder
    const yearFolderId = await findFolder(year.toString(), accessToken, folderId);
    if (!yearFolderId) continue;

    // Then find "Reporte" spreadsheet inside it
    const query = `name='Reporte' and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false and '${yearFolderId}' in parents`;

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
        // Tag with year for logging
        spreadsheets.push(...data.files.map(f => ({ ...f, name: `${year} Reporte` })));
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
 * Process pending ITBIS rows for a single spreadsheet folder
 */
async function processPendingForFolder(
  accessToken: string,
  folderId?: string,
  tenantName?: string
): Promise<{ pending: number; updated: number }> {
  const label = tenantName ? `[${tenantName}] ` : '';
  const spreadsheets = await getYearSpreadsheets(accessToken, folderId);

  if (spreadsheets.length === 0) {
    console.log(`${label}No spreadsheets found`);
    return { pending: 0, updated: 0 };
  }

  let totalPending = 0;
  let totalUpdated = 0;

  for (const spreadsheet of spreadsheets) {
    console.log(`${label}Checking spreadsheet: ${spreadsheet.name}`);

    const pendingRows = await findPendingRows(spreadsheet.id, accessToken);
    totalPending += pendingRows.length;

    for (const row of pendingRows) {
      console.log(`${label}Processing pending row: ${row.encf}`);

      const params = parseUrl(row.url);
      if (!params) {
        console.log(`${label}Could not parse DGII URL for ${row.encf}, skipping`);
        continue;
      }

      // Try direct page scrape first, then form-based approach (same as initial fetch)
      let scraped = await scrapePage(row.url);
      if (!scraped) {
        console.log(`${label}Direct scrape failed for ${row.encf}, trying form...`);
        scraped = await scrapeViaForm(
          params.rncEmisor,
          params.encf,
          params.rncComprador,
          params.codigoSeguridad
        );
      }

      if (scraped) {
        const updated = await updateRowWithItbis(
          spreadsheet.id,
          row.sheetName,
          row.rowIndex,
          parseNumber(scraped.itbis).toFixed(2),
          scraped.status,
          accessToken
        );

        if (updated) {
          console.log(`${label}Updated ${row.encf} with ITBIS: ${scraped.itbis}`);
          totalUpdated++;
        }
      } else {
        console.log(`${label}Still could not get ITBIS for ${row.encf}`);
      }
    }
  }

  return { pending: totalPending, updated: totalUpdated };
}

/**
 * Handle scheduled cron trigger
 * Searches for "Pendiente ITBIS" rows and tries to scrape ITBIS for each
 * Supports multi-tenant mode: iterates over all configured tenants
 */
export async function handleCron(env: Env): Promise<void> {
  console.log('Starting cron job: processing pending ITBIS rows');

  const accessToken = await getAccessToken(
    env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    env.GOOGLE_PRIVATE_KEY
  );

  let totalPending = 0;
  let totalUpdated = 0;

  // Check if multi-tenant mode is configured
  if (env.TENANTS_CONFIG) {
    try {
      const tenants = JSON.parse(env.TENANTS_CONFIG) as Record<string, TenantConfig>;

      // Deduplicate folder IDs (multiple chats may share the same tenant folders)
      const processedFolders = new Set<string>();

      for (const tenant of Object.values(tenants)) {
        const folderKey = tenant.folderId || '__default__';
        if (processedFolders.has(folderKey)) continue;
        processedFolders.add(folderKey);

        console.log(`Processing tenant: ${tenant.name}`);
        const result = await processPendingForFolder(accessToken, tenant.folderId, tenant.name);
        totalPending += result.pending;
        totalUpdated += result.updated;
      }
    } catch (error) {
      console.error('Failed to parse TENANTS_CONFIG in cron:', error);
    }
  } else {
    // Single-tenant mode
    const result = await processPendingForFolder(accessToken, env.SPREADSHEET_FOLDER_ID);
    totalPending += result.pending;
    totalUpdated += result.updated;
  }

  console.log(`Cron job completed. Pending: ${totalPending}, Updated: ${totalUpdated}`);
}
