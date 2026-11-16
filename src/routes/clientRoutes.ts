import { Router } from 'express';
import databaseService from '../services/databaseService.js';
import { getAllTenantsWithStorage } from '../services/acronisService.js';

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
      const rows = clients.map((c: any) => ({
        siteName: c.site_name,
        tenantId: c.tenant_id,
        tenantUuid: c.tenant_uuid,
        percentUsed: c.percent_used ?? 0,
        usedFormatted: c.used_formatted ?? '—',
        quotaFormatted: c.quota_formatted ?? 'No quota set',
        alertType: c.alert_type ?? 'None',
        threshold: c.storage_threshold ?? 80,
        clientDbId: c.id,
        lastSyncedAt: c.last_synced_at ?? null,
      }));
      res.json(rows);
      return;
    }

    // Refresh from Acronis and persist to DB
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
        alert_type: a.alertType,
      });
      return {
        siteName: a.tenantName,
        tenantId: a.tenantId,
        tenantUuid: a.tenantUuid,
        percentUsed: a.percentUsed,
        usedFormatted: a.usedFormatted,
        quotaFormatted: a.quotaFormatted,
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
