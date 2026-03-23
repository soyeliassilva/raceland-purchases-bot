import { MONTH_NAMES, FETCH_TIMEOUT_MS } from '../types.js';

/**
 * Create AbortSignal with timeout
 */
function createTimeoutSignal(ms: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

/**
 * Search for a folder in Drive by name and parent
 */
async function findFolder(
  name: string,
  accessToken: string,
  parentFolderId?: string
): Promise<string | null> {
  let query = `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  if (parentFolderId) {
    query += ` and '${parentFolderId}' in parents`;
  }

  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name)&supportsAllDrives=true&includeItemsFromAllDrives=true`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: createTimeoutSignal(FETCH_TIMEOUT_MS),
    }
  );

  if (!response.ok) {
    console.error(`Drive folder search failed: ${response.status}`);
    return null;
  }

  const data = await response.json() as { files: Array<{ id: string }> };
  if (data.files && data.files.length > 0) {
    return data.files[0].id;
  }

  return null;
}

/**
 * Create a folder in Drive
 */
async function createFolder(
  name: string,
  accessToken: string,
  parentFolderId?: string
): Promise<string> {
  const body: Record<string, unknown> = {
    name,
    mimeType: 'application/vnd.google-apps.folder',
  };

  if (parentFolderId) {
    body.parents = [parentFolderId];
  }

  const response = await fetch(
    'https://www.googleapis.com/drive/v3/files?supportsAllDrives=true',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: createTimeoutSignal(FETCH_TIMEOUT_MS),
    }
  );

  if (!response.ok) {
    const errorBody = await response.text();
    console.error(`Drive folder creation failed: ${response.status}`, errorBody);
    throw new Error(`Drive folder creation failed: ${response.status}`);
  }

  const data = await response.json() as { id: string };
  return data.id;
}

/**
 * Get or create the receipt folder structure: Facturas/{YYYY}/{month}/
 * Returns the month folder ID
 */
export async function getOrCreateReceiptFolder(
  year: number,
  monthIndex: number,
  accessToken: string,
  baseFolderId?: string
): Promise<string> {
  const monthName = MONTH_NAMES[monthIndex];

  // Find or create "Facturas" folder
  let facturasFolderId = await findFolder('Facturas', accessToken, baseFolderId);
  if (!facturasFolderId) {
    console.log('Creating Facturas folder...');
    facturasFolderId = await createFolder('Facturas', accessToken, baseFolderId);
  }

  // Find or create year folder
  const yearStr = year.toString();
  let yearFolderId = await findFolder(yearStr, accessToken, facturasFolderId);
  if (!yearFolderId) {
    console.log(`Creating year folder: ${yearStr}`);
    yearFolderId = await createFolder(yearStr, accessToken, facturasFolderId);
  }

  // Find or create month folder
  let monthFolderId = await findFolder(monthName, accessToken, yearFolderId);
  if (!monthFolderId) {
    console.log(`Creating month folder: ${monthName}`);
    monthFolderId = await createFolder(monthName, accessToken, yearFolderId);
  }

  return monthFolderId;
}

/**
 * Upload a receipt image to Google Drive
 * Returns the file's webViewLink URL
 */
export async function uploadReceiptImage(
  imageBuffer: ArrayBuffer,
  filename: string,
  folderId: string,
  accessToken: string
): Promise<{ fileId: string; webViewLink: string }> {
  console.log(`Uploading image: ${filename} to folder ${folderId}`);

  // Create multipart/form-data request body
  const boundary = '-------formboundary-' + Math.random().toString(36).substring(2);
  const metadata = {
    name: filename,
    parents: [folderId],
    mimeType: 'image/jpeg',
  };

  // Build multipart body
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];

  // Metadata part
  parts.push(encoder.encode(`--${boundary}\r\n`));
  parts.push(encoder.encode('Content-Type: application/json; charset=UTF-8\r\n\r\n'));
  parts.push(encoder.encode(JSON.stringify(metadata)));
  parts.push(encoder.encode('\r\n'));

  // Image data part
  parts.push(encoder.encode(`--${boundary}\r\n`));
  parts.push(encoder.encode('Content-Type: image/jpeg\r\n\r\n'));
  parts.push(new Uint8Array(imageBuffer));
  parts.push(encoder.encode('\r\n'));

  // End boundary
  parts.push(encoder.encode(`--${boundary}--\r\n`));

  // Calculate total length
  const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
  const combined = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    combined.set(part, offset);
    offset += part.length;
  }

  const response = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body: combined,
      signal: createTimeoutSignal(FETCH_TIMEOUT_MS * 2), // Longer timeout for uploads
    }
  );

  if (!response.ok) {
    const errorBody = await response.text();
    console.error(`Drive file upload failed: ${response.status}`, errorBody);
    throw new Error(`Drive file upload failed: ${response.status}`);
  }

  const data = await response.json() as { id: string; webViewLink: string };

  console.log(`File uploaded successfully: ${data.id}`);
  return {
    fileId: data.id,
    webViewLink: data.webViewLink,
  };
}
