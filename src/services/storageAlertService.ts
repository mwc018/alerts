import { getStorageQuotaAlerts, getAllTenantsWithStorage } from './acronisService.js';
import databaseService from './databaseService.js';
import { createTicket, closeTicket, addTicketComment } from './zohoService.js';
import config from '../config/config.js';

const DEFAULT_THRESHOLD = 80;

export async function syncStorageQuotaAlerts(): Promise<{
  added: number;
  updated: number;
  resolved: number;
  suppressed: number;
}> {
  const acronisAlerts = await getStorageQuotaAlerts();
  const dbAlerts = databaseService.getAllStorageQuotaAlerts(false);

  const acronisAlertIds = new Set(acronisAlerts.map((a) => a.alertId));
  const dbAlertMap = new Map(dbAlerts.map((a: any) => [a.alert_id, a]));

  let added = 0;
  let updated = 0;
  let resolved = 0;
  let suppressed = 0;

  for (const alert of acronisAlerts) {
    const clientMapping = databaseService.lookupClientBySiteName(alert.tenantName);
    const threshold = clientMapping?.storage_threshold ?? DEFAULT_THRESHOLD;

    // Suppress alerts for clients flagged for quota review
    if (clientMapping?.needs_quota_review) {
      suppressed++;
      console.log(`[StorageAlert] Suppressed ${alert.tenantName}: flagged for quota review`);
      continue;
    }

    // StorageQuotaExceeded always alerts regardless of threshold
    const meetsThreshold = alert.alertType === 'StorageQuotaExceeded' || alert.percentUsed >= threshold;

    if (!meetsThreshold) {
      suppressed++;
      console.log(
        `[StorageAlert] Suppressed ${alert.tenantName}: ${alert.percentUsed}% < threshold ${threshold}%`
      );
      continue;
    }

    const isNew = !dbAlertMap.has(alert.alertId);
    const existing = dbAlertMap.get(alert.alertId);

    databaseService.upsertStorageQuotaAlert({
      alert_id: alert.alertId,
      alert_type: alert.alertType,
      tenant_id: alert.tenantId,
      tenant_uuid: alert.tenantUuid,
      tenant_name: alert.tenantName,
      storage_type: alert.storageType,
      percent_used: alert.percentUsed,
      used_bytes: alert.usedBytes,
      quota_bytes: alert.quotaBytes,
      threshold_pct: threshold,
      alerted_at: alert.alertedAt,
    });

    if (isNew) {
      added++;
    } else {
      updated++;
    }

    const needsTicket = isNew || (existing && !existing.zoho_ticket_id);
    if (!needsTicket) continue;

    try {
      const subject = buildSubject(alert);
      const description = buildDescription(alert, threshold, clientMapping?.zoho_account_name);

      if (clientMapping) {
        console.log(
          `[StorageAlert] Matched "${alert.tenantName}" → ${clientMapping.zoho_account_name} (${clientMapping.client_email})`
        );
      } else {
        console.warn(`[StorageAlert] No client mapping for "${alert.tenantName}" — using fallback contact`);
      }

      const priority = alert.alertType === 'StorageQuotaExceeded' || alert.percentUsed >= 90 ? 'High' : 'Medium';

      const zohoTicket = await createTicket({
        subject: clientMapping ? subject : `[UNMATCHED SITE] ${subject}`,
        description: clientMapping
          ? description
          : description + '\n\n<p style="color:#cc0000;"><strong>⚠ No company found in client database for this site. Please add it at /admin.</strong></p>',
        contactEmail: clientMapping?.client_email || 'jreynolds@ttalx.com',
        contactName: clientMapping?.zoho_account_name || alert.tenantName,
        accountId: clientMapping?.zoho_account_id,
        status: 'Open',
        priority,
      });

      console.log(
        `[StorageAlert] Created Zoho ticket ${zohoTicket.ticketNumber} for ${alert.tenantName} (${alert.percentUsed}%)`
      );

      const ticketUrl = `${config.zoho.baseUrl}/agent/${config.zoho.orgSlug}/${config.zoho.departmentSlug}/tickets/details/${zohoTicket.id}`;
      databaseService.updateStorageQuotaAlertZohoTicket(
        alert.alertId,
        zohoTicket.id,
        zohoTicket.ticketNumber,
        ticketUrl
      );
    } catch (err: any) {
      console.error(`[StorageAlert] Failed to create ticket for ${alert.tenantName}:`, err.message);
    }
  }

  // Resolve alerts that cleared in Acronis
  for (const dbAlert of dbAlerts) {
    if (!acronisAlertIds.has(dbAlert.alert_id)) {
      if (dbAlert.zoho_ticket_id) {
        try {
          const resolvedAt = new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
          await addTicketComment(
            dbAlert.zoho_ticket_id,
            `Storage quota alert cleared by Acronis on ${resolvedAt}. Storage usage has returned below threshold.`
          );
          await closeTicket(dbAlert.zoho_ticket_id);
          console.log(`[StorageAlert] Closed Zoho ticket ${dbAlert.zoho_ticket_number} for ${dbAlert.tenant_name}`);
        } catch (err: any) {
          console.error(`[StorageAlert] Failed to close ticket for ${dbAlert.tenant_name}:`, err.message);
        }
      }

      databaseService.resolveStorageQuotaAlert(dbAlert.alert_id);
      resolved++;
    }
  }

  return { added, updated, resolved, suppressed };
}

export async function takeStorageSnapshots(): Promise<number> {
  const tenants = await getAllTenantsWithStorage(true);
  for (const t of tenants) {
    databaseService.insertStorageSnapshot({
      tenant_uuid: t.tenantUuid,
      site_name: t.tenantName,
      percent_used: t.percentUsed,
      used_bytes: t.usedBytes,
      quota_bytes: t.quotaBytes,
      used_formatted: t.usedFormatted,
      quota_formatted: t.quotaFormatted,
      total_used_bytes: t.totalUsedBytes,
      total_used_formatted: t.totalUsedFormatted,
      alert_type: t.alertType,
    });
  }
  console.log(`[StorageSnapshot] Recorded ${tenants.length} snapshots for ${new Date().toISOString().split('T')[0]}`);
  return tenants.length;
}

function buildSubject(alert: { alertType: string; tenantName: string; percentUsed: number; storageType: string }): string {
  if (alert.alertType === 'StorageQuotaExceeded') {
    return `URGENT: Storage Quota Exceeded — Backups Blocked — ${alert.tenantName}`;
  }
  return `Storage at ${alert.percentUsed}% — Action Required: ${alert.tenantName}`;
}

function buildDescription(
  alert: {
    tenantName: string;
    alertType: string;
    percentUsed: number;
    usedFormatted: string;
    quotaFormatted: string;
    storageType: string;
    alertedAt: string;
  },
  threshold: number,
  accountName?: string
): string {
  const isExceeded = alert.alertType === 'StorageQuotaExceeded';
  const heading = isExceeded ? 'Storage Quota Exceeded' : 'Storage Quota Warning';
  const urgencyNote = isExceeded
    ? '<p style="color:#cc0000;"><strong>⚠ This client\'s storage quota is fully exceeded. Further backups will fail until quota is increased or old backups are deleted (note: deleted backups may take up to 2 weeks to free space).</strong></p>'
    : `<p style="color:#e67300;"><strong>⚠ Storage is at ${alert.percentUsed}% — act now to avoid backups failing. Note: deleted backups may take up to 2 weeks to free space.</strong></p>`;

  return `
<h3>${heading}</h3>
${urgencyNote}
<table border="0" cellpadding="5" cellspacing="0">
  <tr><td><strong>Client:</strong></td><td>${accountName || alert.tenantName}</td></tr>
  <tr><td><strong>Storage Used:</strong></td><td>${alert.usedFormatted} of ${alert.quotaFormatted} (${alert.percentUsed}%)</td></tr>
  <tr><td><strong>Storage Type:</strong></td><td>${alert.storageType}</td></tr>
  <tr><td><strong>Alert Threshold:</strong></td><td>${threshold}%</td></tr>
  <tr><td><strong>First Detected:</strong></td><td>${alert.alertedAt || 'Unknown'}</td></tr>
</table>

<h4>Recommended Actions</h4>
<ol>
  <li>Log into Acronis and review backup retention policies for this client</li>
  <li>Delete unneeded backup archives if possible</li>
  <li>If quota increase is needed, coordinate with management to adjust the storage plan</li>
  <li>Remember: deleted backups can take up to 2 weeks to fully release quota</li>
</ol>

<hr>
<p><em>This ticket was automatically created by the Acronis backup alert sync.</em></p>
  `.trim();
}
