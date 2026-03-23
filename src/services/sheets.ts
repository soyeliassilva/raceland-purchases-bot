import type { Invoice, SheetRow, Env } from '../types.js';
import { MONTH_NAMES, FETCH_TIMEOUT_MS } from '../types.js';

const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive',
];

const HEADER_ROW = [
  'Fecha', 'Estado', 'ENCF', 'RNC Vendedor', 'Nombre Vendedor', 'ITBIS', 'Total', 'URL', 'Añadido Por', 'Añadido El',
];

// Token cache (module-level, persists within single Worker invocation)
let cachedToken: { token: string; expiresAt: number } | null = null;

/**
 * Create AbortSignal with timeout
 */
function createTimeoutSignal(ms: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

/**
 * Base64URL encode for JWT
 */
function base64UrlEncode(data: string | ArrayBuffer): string {
  let base64: string;
  if (typeof data === 'string') {
    base64 = btoa(data);
  } else {
    const bytes = new Uint8Array(data);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    base64 = btoa(binary);
  }
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

/**
 * Import PKCS#8 private key for signing
 */
async function importPrivateKey(pem: string): Promise<CryptoKey> {
  // Normalize line endings and remove PEM headers
  const normalized = pem
    .replace(/\\n/g, '\n')
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s/g, '');

  const binaryString = atob(normalized);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }

  return crypto.subtle.importKey(
    'pkcs8',
    bytes.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
}

/**
 * Generate access token using service account credentials (with caching)
 */
export async function getAccessToken(email: string, privateKey: string): Promise<string> {
  // Check cache (with 5 minute buffer before expiry)
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now + 300000) {
    console.log('Using cached token');
    return cachedToken.token;
  }
  console.log('Generating fresh token for:', email);
  console.log('Scopes:', SCOPES.join(', '));

  const nowSeconds = Math.floor(now / 1000);
  const exp = nowSeconds + 3600; // 1 hour

  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: email,
    scope: SCOPES.join(' '),
    aud: 'https://oauth2.googleapis.com/token',
    iat: nowSeconds,
    exp: exp,
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signatureInput = `${encodedHeader}.${encodedPayload}`;

  const key = await importPrivateKey(privateKey);
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(signatureInput)
  );

  const jwt = `${signatureInput}.${base64UrlEncode(signature)}`;

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
    signal: createTimeoutSignal(FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    console.error(`Token exchange failed: ${response.status}`, errorBody);
    throw new Error(`Token exchange failed: ${response.status}`);
  }

  const data = await response.json() as { access_token: string };

  // Cache the token
  cachedToken = {
    token: data.access_token,
    expiresAt: now + 3600000, // 1 hour from now
  };

  console.log('Token obtained successfully');
  return data.access_token;
}

/**
 * Find or create spreadsheet for the given year
 */
export async function getOrCreateSpreadsheet(
  year: number,
  accessToken: string,
  folderId?: string
): Promise<string> {
  const name = `${year}`;

  // Search for existing spreadsheet
  let query = `name='${name}' and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false`;
  if (folderId) {
    query += ` and '${folderId}' in parents`;
  }

  const searchResponse = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name)&supportsAllDrives=true&includeItemsFromAllDrives=true`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: createTimeoutSignal(FETCH_TIMEOUT_MS),
    }
  );

  if (!searchResponse.ok) {
    const errorBody = await searchResponse.text();
    console.error(`Drive search failed: ${searchResponse.status}`, errorBody);
    throw new Error(`Drive search failed: ${searchResponse.status}`);
  }

  const searchData = await searchResponse.json() as { files: Array<{ id: string }> };

  if (searchData.files && searchData.files.length > 0) {
    console.log(`Found existing spreadsheet: ${searchData.files[0].id}`);
    return searchData.files[0].id;
  }

  console.log(`No existing spreadsheet found for ${name}, creating new one...`);
  // Create new spreadsheet via Drive API
  const createBody: Record<string, unknown> = {
    name,
    mimeType: 'application/vnd.google-apps.spreadsheet',
  };
  if (folderId) {
    createBody.parents = [folderId];
  }

  // Always include supportsAllDrives for Shared Drive compatibility
  const createUrl = 'https://www.googleapis.com/drive/v3/files?supportsAllDrives=true';

  const createResponse = await fetch(createUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(createBody),
    signal: createTimeoutSignal(FETCH_TIMEOUT_MS),
  });

  if (!createResponse.ok) {
    const errorBody = await createResponse.text();
    console.error(`Spreadsheet creation failed: ${createResponse.status}`, errorBody);
    throw new Error(`Spreadsheet creation failed: ${createResponse.status}`);
  }

  const createData = await createResponse.json() as { id: string };
  const spreadsheetId = createData.id;
  console.log(`Created spreadsheet: ${spreadsheetId}`);

  return spreadsheetId;
}

/**
 * Get or create sheet for the given month
 */
export async function getOrCreateSheet(
  spreadsheetId: string,
  monthIndex: number,
  accessToken: string
): Promise<string> {
  const monthName = MONTH_NAMES[monthIndex];

  // Get spreadsheet metadata
  const metaResponse = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: createTimeoutSignal(FETCH_TIMEOUT_MS),
    }
  );

  if (!metaResponse.ok) {
    throw new Error(`Spreadsheet metadata fetch failed: ${metaResponse.status}`);
  }

  const metaData = await metaResponse.json() as {
    sheets: Array<{ properties: { title: string; sheetId: number } }>;
  };

  // Check if sheet exists
  const existingSheet = metaData.sheets?.find(
    (s) => s.properties.title === monthName
  );
  if (existingSheet) {
    return monthName;
  }

  // Create new sheet
  const createResponse = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        requests: [
          {
            addSheet: {
              properties: { title: monthName },
            },
          },
        ],
      }),
      signal: createTimeoutSignal(FETCH_TIMEOUT_MS),
    }
  );

  if (!createResponse.ok) {
    throw new Error(`Month sheet creation failed: ${createResponse.status}`);
  }

  // Add header row
  const headerResponse = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(monthName)}!A1?valueInputOption=RAW`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ values: [HEADER_ROW] }),
      signal: createTimeoutSignal(FETCH_TIMEOUT_MS),
    }
  );

  if (!headerResponse.ok) {
    throw new Error(`Month header creation failed: ${headerResponse.status}`);
  }

  return monthName;
}

/**
 * Check if ENCF already exists in the month sheet (column C)
 */
export async function isDuplicate(
  spreadsheetId: string,
  sheetName: string,
  encf: string,
  accessToken: string
): Promise<boolean> {
  const response = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(sheetName)}!C:C`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: createTimeoutSignal(FETCH_TIMEOUT_MS),
    }
  );

  if (!response.ok) {
    // If sheet doesn't exist yet, not a duplicate
    if (response.status === 400) {
      return false;
    }
    throw new Error(`Duplicate check failed: ${response.status}`);
  }

  const data = await response.json() as { values?: string[][] };
  if (!data.values) {
    return false;
  }

  return data.values.some((row) => row[0] === encf);
}

/**
 * Check if (seller RNC + ENCF) combination already exists in the month sheet
 * Checks both column D (RNC Vendedor) and column C (ENCF)
 */
export async function isDuplicateWithRnc(
  spreadsheetId: string,
  sheetName: string,
  rncEmisor: string,
  encf: string,
  accessToken: string
): Promise<boolean> {
  // Get both columns C (ENCF) and D (RNC Vendedor)
  const response = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(sheetName)}!C:D`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: createTimeoutSignal(FETCH_TIMEOUT_MS),
    }
  );

  if (!response.ok) {
    // If sheet doesn't exist yet, not a duplicate
    if (response.status === 400) {
      return false;
    }
    throw new Error(`Duplicate check failed: ${response.status}`);
  }

  const data = await response.json() as { values?: string[][] };
  if (!data.values) {
    return false;
  }

  // Check if any row has matching RNC Emisor AND ENCF
  return data.values.some((row) => {
    const rowEncf = row[0]; // Column C
    const rowRnc = row[1]; // Column D
    return rowEncf === encf && rowRnc === rncEmisor;
  });
}

/**
 * Append row to specified sheet
 */
export async function appendRow(
  spreadsheetId: string,
  sheetName: string,
  row: SheetRow,
  accessToken: string
): Promise<void> {
  const values = [
    [
      row.date,
      row.status,
      row.encf,
      row.vendorRnc,
      row.vendorName,
      row.itbis,
      row.total,
      row.url,
      row.addedBy,
      row.addedAt,
    ],
  ];

  const response = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(sheetName)}!A:J:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ values }),
      signal: createTimeoutSignal(FETCH_TIMEOUT_MS),
    }
  );

  if (!response.ok) {
    throw new Error(`Row append failed: ${response.status}`);
  }
}

/**
 * Format invoice date for display
 */
function formatDate(date: Date): string {
  const day = date.getUTCDate().toString().padStart(2, '0');
  const month = (date.getUTCMonth() + 1).toString().padStart(2, '0');
  const year = date.getUTCFullYear();
  return `${day}/${month}/${year}`;
}

const RNC_API_URL = 'https://rnc.megaplus.com.do/api/consulta';

/**
 * Look up vendor name by RNC using free API
 */
export async function lookupVendorName(vendorRnc: string): Promise<string | null> {
  try {
    console.log(`Looking up vendor name for RNC: ${vendorRnc}`);

    const response = await fetch(`${RNC_API_URL}?rnc=${vendorRnc}`, {
      signal: createTimeoutSignal(FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      console.error(`RNC API failed: ${response.status}`);
      return null;
    }

    const data = await response.json() as {
      error: boolean;
      nombre_razon_social?: string;
    };

    if (data.error || !data.nombre_razon_social) {
      console.log(`No vendor found for RNC: ${vendorRnc}`);
      return null;
    }

    console.log(`Found vendor name: ${data.nombre_razon_social}`);
    return data.nombre_razon_social;
  } catch (error) {
    console.error('Error looking up vendor by RNC:', error);
    return null;
  }
}

/**
 * Add invoice to Google Sheets (main orchestration function)
 */
export async function addInvoiceToSheet(
  invoice: Invoice,
  username: string,
  env: Env,
  driveUrl?: string
): Promise<'success' | 'duplicate'> {
  const accessToken = await getAccessToken(
    env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    env.GOOGLE_PRIVATE_KEY
  );

  const year = invoice.fechaEmision.getUTCFullYear();
  const monthIndex = invoice.fechaEmision.getUTCMonth();

  // Get or create spreadsheet
  const spreadsheetId = await getOrCreateSpreadsheet(
    year,
    accessToken,
    env.SPREADSHEET_FOLDER_ID
  );

  // Get or create month sheet
  const sheetName = await getOrCreateSheet(spreadsheetId, monthIndex, accessToken);

  // Check for duplicate in the month sheet (use enhanced check for photo invoices)
  if (invoice.source === 'photo') {
    if (await isDuplicateWithRnc(spreadsheetId, sheetName, invoice.rncEmisor, invoice.encf, accessToken)) {
      return 'duplicate';
    }
  } else {
    if (await isDuplicate(spreadsheetId, sheetName, invoice.encf, accessToken)) {
      return 'duplicate';
    }
  }

  // Look up vendor name from DGII if not already available
  let vendorName = invoice.vendorName;
  if (!vendorName) {
    vendorName = await lookupVendorName(invoice.rncEmisor);
  }

  // Prepare row data
  const row: SheetRow = {
    date: formatDate(invoice.fechaEmision),
    status: invoice.status,
    encf: invoice.encf,
    vendorRnc: invoice.rncEmisor,
    vendorName: vendorName || invoice.rncEmisor, // Fallback to RNC if no name
    itbis: invoice.itbis !== null ? invoice.itbis.toFixed(2) : '',
    total: invoice.montoTotal.toFixed(2),
    url: driveUrl || invoice.originalUrl, // Use Drive URL for photos, DGII URL for URLs
    addedBy: username,
    addedAt: new Date().toISOString(),
  };

  // Append row to month sheet
  await appendRow(spreadsheetId, sheetName, row, accessToken);

  return 'success';
}
