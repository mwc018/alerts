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
        StorageType?: string;
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

export interface StorageQuotaAlert {
  alertId: string;
  alertType: 'StorageQuotaAt80' | 'StorageQuotaExceeded';
  tenantId: string;
  tenantUuid: string;
  tenantName: string;
  storageType: string;
  usedBytes: number;
  quotaBytes: number;
  percentUsed: number;
  usedFormatted: string;
  quotaFormatted: string;
  alertedAt: string;
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

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

async function getTenantUsages(token: string, tenantUuid: string): Promise<any[]> {
  try {
    const response = await axios.get(
      `${config.acronis.baseUrl}/api/2/tenants/${tenantUuid}/usages`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    return response.data.items || [];
  } catch {
    return [];
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

export async function getStorageQuotaAlerts(): Promise<StorageQuotaAlert[]> {
  const token = await getAcronisToken();

  // Fetch both storage alert types — single type param works; comma-separated does not
  const [at80Resp, exceededResp] = await Promise.all([
    axios.get(`${config.acronis.baseUrl}/api/alert_manager/v1/alerts?type=StorageQuotaAt80`, {
      headers: { Authorization: `Bearer ${token}` },
    }),
    axios.get(`${config.acronis.baseUrl}/api/alert_manager/v1/alerts?type=StorageQuotaExceeded`, {
      headers: { Authorization: `Bearer ${token}` },
    }),
  ]);

  const rawAlerts: AcronisAlert[] = [
    ...(at80Resp.data.items || at80Resp.data.alerts || []),
    ...(exceededResp.data.items || exceededResp.data.alerts || []),
  ];

  // Deduplicate by alert ID (shouldn't overlap but be safe)
  const seen = new Set<string>();
  const alerts = rawAlerts.filter((a) => {
    if (seen.has(a.id)) return false;
    seen.add(a.id);
    return true;
  });

  // Enrich with actual usage percentages
  const results: StorageQuotaAlert[] = [];

  for (const alert of alerts) {
    const tenantUuid = alert.tenant?.uuid || '';
    const tenantId = alert.tenant?.id || '';
    const tenantName =
      alert.details?.error?.fields?.TenantName ||
      alert.details?.errorMessage?.context?.tenantName ||
      (tenantUuid ? (await getTenantInfo(tenantUuid)).name : undefined) ||
      `Tenant ${tenantId}`;

    const storageType = alert.details?.error?.fields?.StorageType || 'cloud';

    let usedBytes = 0;
    let quotaBytes = 0;

    if (tenantUuid) {
      const usages = await getTenantUsages(token, tenantUuid);
      for (const item of usages) {
        if (item.measurement_unit !== 'bytes') continue;
        const quota = item.offering_item?.quota?.value;
        if (!quota) continue;
        usedBytes += item.value || 0;
        quotaBytes += quota;
      }
    }

    const percentUsed = quotaBytes > 0 ? Math.round((usedBytes / quotaBytes) * 100) : 0;

    results.push({
      alertId: alert.id,
      alertType: alert.type as 'StorageQuotaAt80' | 'StorageQuotaExceeded',
      tenantId,
      tenantUuid,
      tenantName: typeof tenantName === 'string' ? tenantName.replace(/\s*\([^)]*\)/g, '').trim() : String(tenantName),
      storageType: storageType === 'cloud' ? 'Cloud' : storageType,
      usedBytes,
      quotaBytes,
      percentUsed,
      usedFormatted: formatBytes(usedBytes),
      quotaFormatted: quotaBytes > 0 ? formatBytes(quotaBytes) : 'Unknown',
      alertedAt: alert.createdAt || alert.created_at || '',
    });
  }

  return results.sort((a, b) => b.percentUsed - a.percentUsed);
}
