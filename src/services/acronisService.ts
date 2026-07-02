import axios from 'axios';
import config from '../config/config.js';

interface AcronisToken {
  access_token: string;
  expires_at: number;
}

export interface AcronisAlert {
  id: string;
  type: string;
  details: {
    resourceName?: string;
    resource?: { name?: string };
    backupLocations?: Array<{ name: string; type: string }>;
    errorMessage?: {
      reason?: string;
      context?: {
        tenantName?: string;
        cause_str?: string;
      };
    };
    error?: {
      text?: string;
      fields?: {
        ResourceName?: string;
        TenantName?: string;
      };
    };
  };
  createdAt?: string;
  created_at?: string;
  tenant?: {
    id: string;
    uuid: string;
    name?: string;
  };
}

let tokenCache: AcronisToken | null = null;

async function getAcronisToken(): Promise<string> {
  const now = Date.now();
  if (tokenCache && tokenCache.expires_at > now + 5 * 60 * 1000) {
    return tokenCache.access_token;
  }

  const { baseUrl, clientId, clientSecret } = config.acronis;
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const response = await axios.post(
    `${baseUrl}/api/2/idp/token`,
    'grant_type=client_credentials',
    {
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    }
  );

  tokenCache = {
    access_token: response.data.access_token,
    expires_at: now + response.data.expires_in * 1000,
  };

  return tokenCache.access_token;
}

async function getTenantInfo(uuid: string): Promise<{ name?: string }> {
  try {
    const token = await getAcronisToken();
    const response = await axios.get(`${config.acronis.baseUrl}/api/2/tenants/${uuid}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return response.data;
  } catch {
    return {};
  }
}

const ACTIONABLE_TYPES = new Set(['BackupFailed', 'BackupDidNotStart', 'ProtectionServiceNotWorking']);

export async function getActionableBackupAlerts(): Promise<AcronisAlert[]> {
  const token = await getAcronisToken();

  // Fetch all alerts without a type filter — the Acronis API silently returns 0
  // results when multiple types are passed as a comma-separated string.
  const response = await axios.get(`${config.acronis.baseUrl}/api/alert_manager/v1/alerts`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  const all: AcronisAlert[] = response.data.items || response.data.alerts || response.data || [];
  const alerts = all.filter((a) => ACTIONABLE_TYPES.has(a.type));

  // Enrich with tenant names if missing
  const enriched = await Promise.all(
    alerts.map(async (alert) => {
      if (alert.tenant && !alert.tenant.name && alert.tenant.uuid) {
        const info = await getTenantInfo(alert.tenant.uuid);
        return { ...alert, tenant: { ...alert.tenant, name: info.name } };
      }
      return alert;
    })
  );

  return enriched;
}
