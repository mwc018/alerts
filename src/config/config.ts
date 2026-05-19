import dotenv from 'dotenv';

dotenv.config();

interface Config {
  acronis: {
    baseUrl: string;
    clientId: string;
    clientSecret: string;
  };
  zoho: {
    clientId: string;
    clientSecret: string;
    refreshToken: string;
    orgId: string;
    orgSlug: string;
    departmentId: string;
    departmentSlug: string;
    baseUrl: string;
  };
  googleSheets: {
    clientEmail: string;
    privateKey: string;
    spreadsheetId: string;
  };
  database: {
    path: string;
  };
  server: {
    port: number;
    nodeEnv: string;
  };
}

const config: Config = {
  acronis: {
    baseUrl: process.env.ACRONIS_BASE_URL || '',
    clientId: process.env.ACRONIS_CLIENT_ID || '',
    clientSecret: process.env.ACRONIS_CLIENT_SECRET || '',
  },
  zoho: {
    clientId: process.env.ZOHO_CLIENT_ID || '',
    clientSecret: process.env.ZOHO_CLIENT_SECRET || '',
    refreshToken: process.env.ZOHO_REFRESH_TOKEN || '',
    orgId: process.env.ZOHO_ORG_ID || '',
    orgSlug: process.env.ZOHO_ORG_SLUG || '',
    departmentId: process.env.ZOHO_DEPARTMENT_ID || '',
    departmentSlug: process.env.ZOHO_DEPARTMENT_SLUG || '',
    baseUrl: process.env.ZOHO_BASE_URL || 'https://desk.zoho.com',
  },
  googleSheets: {
    clientEmail: process.env.GOOGLE_SHEETS_CLIENT_EMAIL || '',
    privateKey: (process.env.GOOGLE_SHEETS_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    spreadsheetId: process.env.GOOGLE_SHEETS_SPREADSHEET_ID || '',
  },
  database: {
    path: process.env.DATABASE_PATH || './data/backup-alerts.db',
  },
  server: {
    port: parseInt(process.env.PORT || '10000', 10),
    nodeEnv: process.env.NODE_ENV || 'development',
  },
};

const missing: string[] = [];
if (!config.acronis.baseUrl) missing.push('ACRONIS_BASE_URL');
if (!config.acronis.clientId) missing.push('ACRONIS_CLIENT_ID');
if (!config.acronis.clientSecret) missing.push('ACRONIS_CLIENT_SECRET');
if (!config.zoho.clientId) missing.push('ZOHO_CLIENT_ID');
if (!config.zoho.clientSecret) missing.push('ZOHO_CLIENT_SECRET');
if (!config.zoho.refreshToken) missing.push('ZOHO_REFRESH_TOKEN');
if (!config.zoho.orgId) missing.push('ZOHO_ORG_ID');
if (!config.zoho.departmentId) missing.push('ZOHO_DEPARTMENT_ID');

if (missing.length > 0) {
  console.error('ERROR: Missing required environment variables:', missing.join(', '));
  if (config.server.nodeEnv === 'production') {
    process.exit(1);
  }
}

export default config;
