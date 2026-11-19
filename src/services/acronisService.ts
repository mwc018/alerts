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
  totalUsedBytes: number;
  totalUsedFormatted: string;
  onSiteUsedBytes: number;
  onSiteUsedFormatted: string;
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

export async function probeTenantUsages(tenantName: string): Promise<any> {
  const token = await getAcronisToken();
  const partnerUuid = await discoverPartnerUuid(token);

  // Find matching tenant
  const allTenants: any[] = [];
  let after = '';
  do {
    const params: Record<string, string> = { parent_id: partnerUuid, kind: 'customer' };
    if (after) params.after = after;
    const r = await axios.get(`${config.acronis.baseUrl}/api/2/tenants`, {
      headers: { Authorization: `Bearer ${token}` },
      params,
    });
    allTenants.push(...(r.data.items || []));
    after = r.data.paging?.cursors?.after || '';
  } while (after);

  const lower = tenantName.toLowerCase();
  const tenant = allTenants.find((t) =>
    t.name?.toLowerCase().includes(lower) || lower.includes(t.name?.toLowerCase())
  );
  if (!tenant) {
    return { error: `No tenant found matching "${tenantName}"`, available: allTenants.map((t) => t.name) };
  }

  const usages = await getTenantUsages(token, tenant.id);
  return {
    tenantName: tenant.name,
    tenantId: tenant.id,
    totalItems: usages.length,
    items: usages.map((item: any) => ({
      name: item.offering_item?.name,
      measurement_unit: item.measurement_unit,
      value: item.value,
      quota: item.offering_item?.quota?.value ?? null,
      infra_name: item.infra?.name ?? null,
      type: item.offering_item?.type ?? null,
      status: item.offering_item?.status ?? null,
    })),
  };
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

// Cache for the full tenant+storage list — expires after 5 minutes
let _allTenantsCache: { data: StorageQuotaAlert[]; expiresAt: number } | null = null;

async function discoverPartnerUuid(token: string): Promise<string> {
  // Pull one known customer tenant and read its parent_id
  const r = await axios.get(`${config.acronis.baseUrl}/api/alert_manager/v1/alerts?type=StorageQuotaAt80`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const alerts: any[] = r.data.items || r.data.alerts || [];
  if (!alerts.length) {
    // No storage alerts — try fetching any tenant to discover parent
    const all = await axios.get(`${config.acronis.baseUrl}/api/alert_manager/v1/alerts`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const anyAlert = (all.data.items || all.data.alerts || [])[0];
    if (!anyAlert?.tenant?.uuid) throw new Error('Cannot discover partner UUID — no tenants found in alerts');
    alerts.push(anyAlert);
  }
  const customerUuid = alerts[0].tenant?.uuid;
  const tenantResp = await axios.get(`${config.acronis.baseUrl}/api/2/tenants/${customerUuid}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return tenantResp.data.parent_id;
}

export async function getAllTenantsWithStorage(forceRefresh = false): Promise<StorageQuotaAlert[]> {
  const now = Date.now();
  if (!forceRefresh && _allTenantsCache && _allTenantsCache.expiresAt > now) {
    return _allTenantsCache.data;
  }

  const token = await getAcronisToken();

  // Discover partner UUID, then page through all customer tenants
  const partnerUuid = await discoverPartnerUuid(token);

  const allTenants: any[] = [];
  let after = '';
  do {
    const params: Record<string, string> = { parent_id: partnerUuid, kind: 'customer' };
    if (after) params.after = after;
    const r = await axios.get(`${config.acronis.baseUrl}/api/2/tenants`, {
      headers: { Authorization: `Bearer ${token}` },
      params,
    });
    allTenants.push(...(r.data.items || []));
    after = r.data.paging?.cursors?.after || '';
  } while (after);

  // Build a map of active storage alerts for quick lookup
  const [at80Resp, exceededResp] = await Promise.all([
    axios.get(`${config.acronis.baseUrl}/api/alert_manager/v1/alerts?type=StorageQuotaAt80`, {
      headers: { Authorization: `Bearer ${token}` },
    }),
    axios.get(`${config.acronis.baseUrl}/api/alert_manager/v1/alerts?type=StorageQuotaExceeded`, {
      headers: { Authorization: `Bearer ${token}` },
    }),
  ]);
  const activeAlerts: any[] = [
    ...(at80Resp.data.items || at80Resp.data.alerts || []),
    ...(exceededResp.data.items || exceededResp.data.alerts || []),
  ];
  const alertByUuid = new Map(activeAlerts.map((a) => [a.tenant?.uuid, a]));

  // Fetch usages in parallel batches of 10
  const BATCH = 10;
  const results: StorageQuotaAlert[] = [];
  for (let i = 0; i < allTenants.length; i += BATCH) {
    const batch = allTenants.slice(i, i + BATCH);
    const batchResults = await Promise.all(
      batch.map(async (tenant) => {
        const usages = await getTenantUsages(token, tenant.id);
        let usedBytes = 0;
        let quotaBytes = 0;
        let totalUsedBytes = 0;
        for (const item of usages) {
          if (item.measurement_unit !== 'bytes') continue;
          totalUsedBytes += item.value || 0;
          const quota = item.offering_item?.quota?.value;
          if (!quota) continue;  // no quota = local/on-site storage, skip for cloud totals
          usedBytes += item.value || 0;
          quotaBytes += quota;
        }

        const percentUsed = quotaBytes > 0 ? Math.round((usedBytes / quotaBytes) * 100) : 0;
        const alert = alertByUuid.get(tenant.id);
        const alertType: 'StorageQuotaAt80' | 'StorageQuotaExceeded' | 'None' =
          alert?.type === 'StorageQuotaExceeded'
            ? 'StorageQuotaExceeded'
            : alert?.type === 'StorageQuotaAt80'
            ? 'StorageQuotaAt80'
            : 'None';

        return {
          alertId: alert?.id || `tenant-${tenant.id}`,
          alertType: alertType as any,
          tenantId: String(tenant.id),
          tenantUuid: tenant.id,
          tenantName: tenant.name,
          storageType: 'Cloud',
          usedBytes,
          quotaBytes,
          percentUsed,
          usedFormatted: quotaBytes > 0 ? formatBytes(usedBytes) : '—',
          quotaFormatted: quotaBytes > 0 ? formatBytes(quotaBytes) : 'No quota set',
          totalUsedBytes,
          totalUsedFormatted: totalUsedBytes > 0 ? formatBytes(totalUsedBytes) : '—',
          onSiteUsedBytes: totalUsedBytes - usedBytes,
          onSiteUsedFormatted: (totalUsedBytes - usedBytes) > 0 ? formatBytes(totalUsedBytes - usedBytes) : '—',
          alertedAt: alert?.createdAt || alert?.created_at || '',
        };
      })
    );
    results.push(...batchResults);
  }

  const sorted = results.sort((a, b) => b.percentUsed - a.percentUsed);
  _allTenantsCache = { data: sorted, expiresAt: now + 5 * 60 * 1000 };
  return sorted;
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
    let totalUsedBytes = 0;

    if (tenantUuid) {
      const usages = await getTenantUsages(token, tenantUuid);
      for (const item of usages) {
        if (item.measurement_unit !== 'bytes') continue;
        totalUsedBytes += item.value || 0;
        const quota = item.offering_item?.quota?.value;
        if (!quota) continue;  // no quota = local/on-site storage, skip for cloud totals
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
      totalUsedBytes,
      totalUsedFormatted: totalUsedBytes > 0 ? formatBytes(totalUsedBytes) : '—',
      onSiteUsedBytes: totalUsedBytes - usedBytes,
      onSiteUsedFormatted: (totalUsedBytes - usedBytes) > 0 ? formatBytes(totalUsedBytes - usedBytes) : '—',
      alertedAt: alert.createdAt || alert.created_at || '',
    });
  }

  return results.sort((a, b) => b.percentUsed - a.percentUsed);
}
