import { google } from 'googleapis';
import config from '../config/config.js';

export interface ClientMapping {
  title: string;
  clientEmail: string;
  zohoAccountId: string;
  zohoAccountName: string;
  clientEngineer: string;
  zohoEngineerID: string;
  // Column G — storage alert threshold %. If blank, the default (80) is used.
  storageThreshold?: number;
}

let _cache: ClientMapping[] = [];
let _cacheLoadedAt = 0;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

function getAuth() {
  return new google.auth.GoogleAuth({
    credentials: {
      client_email: config.googleSheets.clientEmail,
      private_key: config.googleSheets.privateKey,
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
}

async function loadClientMappings(): Promise<ClientMapping[]> {
  const now = Date.now();
  if (_cache.length > 0 && now - _cacheLoadedAt < CACHE_TTL_MS) {
    return _cache;
  }

  if (!config.googleSheets.clientEmail || !config.googleSheets.spreadsheetId) {
    console.warn('[GoogleSheets] Missing credentials — skipping client mapping lookup');
    return [];
  }

  try {
    const auth = getAuth();
    const sheets = google.sheets({ version: 'v4', auth });

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: config.googleSheets.spreadsheetId,
      // gid=266636608 corresponds to the client mapping sheet
      range: 'Client Mapping!A:G',
    });

    const rows = response.data.values || [];
    // Skip header row
    _cache = rows.slice(1).map((row) => ({
      title: row[0] || '',
      clientEmail: row[1] || '',
      zohoAccountId: row[2] || '',
      zohoAccountName: row[3] || '',
      clientEngineer: row[4] || '',
      zohoEngineerID: row[5] || '',
      storageThreshold: row[6] ? parseInt(row[6], 10) : undefined,
    }));
    _cacheLoadedAt = now;
    console.log(`[GoogleSheets] Loaded ${_cache.length} client mappings`);
    return _cache;
  } catch (error: any) {
    console.error('[GoogleSheets] Failed to load client mappings:', error.message);
    return [];
  }
}

export async function lookupBySiteName(siteName: string): Promise<ClientMapping | null> {
  const mappings = await loadClientMappings();
  if (mappings.length === 0) return null;

  // Tier 1: exact match
  let match = mappings.find((m) => m.title === siteName);
  if (match) return match;

  // Tier 2: case-insensitive
  match = mappings.find((m) => m.title.toLowerCase() === siteName.toLowerCase());
  if (match) return match;

  // Tier 3: partial / substring match
  const lower = siteName.toLowerCase();
  match = mappings.find(
    (m) => m.title.toLowerCase().includes(lower) || lower.includes(m.title.toLowerCase())
  );
  return match || null;
}
