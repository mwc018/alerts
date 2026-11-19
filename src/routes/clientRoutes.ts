import { Router } from 'express';
import databaseService from '../services/databaseService.js';
import { getAllTenantsWithStorage, setTenantStorageQuota } from '../services/acronisService.js';

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '—';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

const router = Router();

router.get('/', (_req, res) => {
  res.json(databaseService.getAllClients());
});

// Storage status — served from DB by default; ?refresh=true fetches from Acronis and saves to DB
router.get('/storage-status', async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === 'true';

    if (!forceRefresh) {
      const clients = databaseService.getAllClients().filter((c: any) => c.tenant_uuid);
      const rows = clients.map((c: any) => {
        const onSiteBytes = (c.total_used_bytes ?? 0) - (c.used_bytes ?? 0);
        return {
          siteName: c.site_name,
          tenantId: c.tenant_id,
          tenantUuid: c.tenant_uuid,
          percentUsed: c.percent_used ?? 0,
          usedFormatted: c.used_formatted ?? '—',
          quotaFormatted: c.quota_formatted ?? 'No quota set',
          totalUsedFormatted: c.total_used_formatted ?? '—',
          onSiteUsedFormatted: onSiteBytes > 0 ? formatBytes(onSiteBytes) : '—',
          m365Mailboxes: c.m365_mailboxes ?? 0,
          needsQuotaReview: !!(c.needs_quota_review),
          alertType: c.alert_type ?? 'None',
          threshold: c.storage_threshold ?? 80,
          clientDbId: c.id,
          lastSyncedAt: c.last_synced_at ?? null,
        };
      });
      res.json(rows);
      return;
    }

    // Refresh from Acronis, persist to DB, and record daily history snapshot
    const tenants = await getAllTenantsWithStorage(true);
    const rows = tenants.map((a) => {
      const saved = databaseService.upsertClientFromAcronis({
        tenant_id: a.tenantId,
        tenant_uuid: a.tenantUuid,
        site_name: a.tenantName,
        percent_used: a.percentUsed,
        used_bytes: a.usedBytes,
        quota_bytes: a.quotaBytes,
        used_formatted: a.usedFormatted,
        quota_formatted: a.quotaFormatted,
        total_used_bytes: a.totalUsedBytes,
        total_used_formatted: a.totalUsedFormatted,
        m365_mailboxes: a.m365Mailboxes,
        alert_type: a.alertType,
      });
      databaseService.insertStorageSnapshot({
        tenant_uuid: a.tenantUuid,
        site_name: a.tenantName,
        percent_used: a.percentUsed,
        used_bytes: a.usedBytes,
        quota_bytes: a.quotaBytes,
        used_formatted: a.usedFormatted,
        quota_formatted: a.quotaFormatted,
        total_used_bytes: a.totalUsedBytes,
        total_used_formatted: a.totalUsedFormatted,
        alert_type: a.alertType,
      });
      return {
        siteName: a.tenantName,
        tenantId: a.tenantId,
        tenantUuid: a.tenantUuid,
        percentUsed: a.percentUsed,
        usedFormatted: a.usedFormatted,
        quotaFormatted: a.quotaFormatted,
        totalUsedFormatted: a.totalUsedFormatted,
        onSiteUsedFormatted: a.onSiteUsedFormatted,
        m365Mailboxes: a.m365Mailboxes,
        needsQuotaReview: !!(saved?.needs_quota_review),
        alertType: a.alertType,
        threshold: saved?.storage_threshold ?? 80,
        clientDbId: saved?.id ?? null,
        lastSyncedAt: saved?.last_synced_at ?? null,
      };
    });

    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', (req, res) => {
  const { site_name } = req.body;
  if (!site_name?.trim()) {
    res.status(400).json({ error: 'site_name is required' });
    return;
  }
  try {
    const client = databaseService.createClient(req.body);
    res.status(201).json(client);
  } catch (err: any) {
    if (err.message?.includes('UNIQUE')) {
      res.status(409).json({ error: `A client named "${site_name}" already exists` });
    } else {
      res.status(500).json({ error: err.message });
    }
  }
});

router.put('/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const client = databaseService.updateClient(id, req.body);
  if (!client) {
    res.status(404).json({ error: 'Client not found' });
    return;
  }
  res.json(client);
});

router.patch('/:id/review-flag', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { flagged } = req.body;
  if (typeof flagged !== 'boolean') {
    res.status(400).json({ error: 'flagged must be a boolean' });
    return;
  }
  const client = databaseService.setReviewFlag(id, flagged);
  if (!client) { res.status(404).json({ error: 'Client not found' }); return; }
  res.json(client);
});

router.patch('/:id/quota', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { quotaBytes } = req.body;
  if (typeof quotaBytes !== 'number' || quotaBytes <= 0) {
    res.status(400).json({ error: 'quotaBytes must be a positive number' });
    return;
  }
  const client = databaseService.getClientById(id);
  if (!client) { res.status(404).json({ error: 'Client not found' }); return; }
  if (!client.tenant_uuid) {
    res.status(400).json({ error: 'Client has no Acronis tenant UUID — sync from Acronis first' });
    return;
  }
  try {
    const result = await setTenantStorageQuota(client.tenant_uuid, quotaBytes);
    res.json({ success: true, ...result });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const deleted = databaseService.deleteClient(id);
  if (!deleted) {
    res.status(404).json({ error: 'Client not found' });
    return;
  }
  res.status(204).send();
});

export default router;
