import { getActionableBackupAlerts } from './acronisService.js';
import databaseService from './databaseService.js';
import { createTicket, closeTicket, addTicketComment } from './zohoService.js';
import config from '../config/config.js';

interface BackupAlert {
  id: string;
  type: string;
  details: {
    resourceName?: string;
    resource?: { name?: string };
    backupLocations?: Array<{
      name: string;
      type: string;
    }>;
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

export async function syncBackupAlerts(): Promise<{
  added: number;
  updated: number;
  resolved: number;
  failedCount: number;
  notStartedCount: number;
  typeBreakdown: Record<string, number>;
}> {
  try {
    const acronisAlerts = await getActionableBackupAlerts();
    const dbAlerts = databaseService.getAllBackupAlerts(false);

    const acronisAlertIds = new Set(acronisAlerts.map((a) => a.id));
    const dbAlertIds = new Set(dbAlerts.map((a: any) => a.alert_id));

    let added = 0;
    let updated = 0;
    let resolved = 0;

    const typeBreakdown: Record<string, number> = {};
    for (const alert of acronisAlerts) {
      typeBreakdown[alert.type] = (typeBreakdown[alert.type] || 0) + 1;
    }
    const failedCount = typeBreakdown['BackupFailed'] || 0;
    const notStartedCount = Object.entries(typeBreakdown)
      .filter(([t]) => t !== 'BackupFailed')
      .reduce((sum, [, n]) => sum + n, 0);
    console.log(`Acronis sync: found types:`, typeBreakdown);

    const dbAlertMap = new Map(dbAlerts.map((a: any) => [a.alert_id, a]));

    for (const alert of acronisAlerts) {
      const isNew = !dbAlertIds.has(alert.id);
      const existingDbAlert = dbAlertMap.get(alert.id);

      const alertData = {
        alert_id: alert.id,
        alert_type: alert.type,
        tenant_id: alert.tenant?.id || 'unknown',
        tenant_name: getTenantName(alert),
        device_name: getDeviceName(alert),
        backup_type: getBackupType(alert.details.backupLocations),
        failure_reason: getFailureReason(alert),
        error_details: JSON.stringify(alert.details.errorMessage || alert.details.error),
        failed_at: alert.createdAt || alert.created_at,
        alert_data: JSON.stringify(alert),
      };

      databaseService.upsertBackupAlert(alertData);

      // O365 mailbox backup errors are informational noise — skip entirely.
      const isO365MailboxAlert = alertData.failure_reason?.startsWith('O365Mailbox') ?? false;
      if (isO365MailboxAlert) {
        console.log(
          `Ignoring O365 mailbox alert: ${alertData.tenant_name} / ${alertData.device_name} (${alertData.failure_reason})`
        );
        continue;
      }

      // OneDrive-related failures are stored in DB but do not create Zoho tickets.
      const isOneDriveAlert = alertData.failure_reason?.startsWith('OD') ?? false;
      if (isOneDriveAlert) {
        console.log(
          `Suppressing Zoho ticket for OneDrive alert: ${alertData.tenant_name} / ${alertData.device_name} (${alertData.failure_reason})`
        );
      }

      const needsTicket =
        !isOneDriveAlert && (isNew || (existingDbAlert && !existingDbAlert.zoho_ticket_id));

      if (isNew) {
        added++;
      } else {
        updated++;
      }

      if (needsTicket) {
        try {
          const subject = getAlertSubject(alert, alertData.device_name, alertData.tenant_name);
          const description = buildAlertDescription(alertData, alert.type);

          const clientMapping = databaseService.lookupClientBySiteName(alertData.tenant_name);
          if (clientMapping) {
            console.log(
              `[BackupAlert] Matched site "${alertData.tenant_name}" → ${clientMapping.zoho_account_name} (${clientMapping.client_email})`
            );
          } else {
            console.warn(
              `[BackupAlert] No client mapping found for site "${alertData.tenant_name}" — using fallback contact`
            );
          }

          const finalDescription = clientMapping
            ? description
            : description +
              '\n\n<p style="color:#cc0000;"><strong>⚠ No company found in client database for this site. Please add it at /admin.</strong></p>';

          const zohoTicket = await createTicket({
            subject: clientMapping ? subject : `[UNMATCHED SITE] ${subject}`,
            description: finalDescription,
            contactEmail: clientMapping?.client_email || 'jreynolds@ttalx.com',
            contactName: clientMapping?.zoho_account_name || alertData.tenant_name,
            accountId: clientMapping?.zoho_account_id,
            status: 'Open',
            priority: alertData.backup_type === 'Cloud' ? 'High' : 'Medium',
          });

          console.log(
            `Auto-created Zoho ticket ${zohoTicket.ticketNumber} for ${alert.type} alert ${alert.id}`
          );

          const ticketUrl = `${config.zoho.baseUrl}/agent/${config.zoho.orgSlug}/${config.zoho.departmentSlug}/tickets/details/${zohoTicket.id}`;

          databaseService.updateBackupAlertZohoTicket(
            alert.id,
            zohoTicket.id,
            zohoTicket.ticketNumber,
            ticketUrl
          );
        } catch (ticketError: any) {
          console.error(
            `Failed to create Zoho ticket for alert ${alert.id}:`,
            ticketError.message
          );
        }
      }
    }

    // Resolve alerts that no longer exist in Acronis
    for (const dbAlert of dbAlerts) {
      if (!acronisAlertIds.has(dbAlert.alert_id)) {
        if (dbAlert.zoho_ticket_id) {
          try {
            const resolvedAt = new Date().toLocaleString('en-US', {
              dateStyle: 'medium',
              timeStyle: 'short',
            });
            await addTicketComment(
              dbAlert.zoho_ticket_id,
              `Backup completed. Alert cleared by Acronis on ${resolvedAt}.`
            );
            await closeTicket(dbAlert.zoho_ticket_id);
            console.log(
              `Auto-resolved: Closed Zoho ticket ${dbAlert.zoho_ticket_number} for alert ${dbAlert.alert_id}`
            );
          } catch (error: any) {
            console.error(
              `Failed to close Zoho ticket during auto-resolve for alert ${dbAlert.alert_id}:`,
              error.message
            );
          }
        }

        try {
          const isOneDrive = dbAlert.failure_reason?.startsWith('OD') ?? false;
          if (isOneDrive) {
            databaseService.deleteBackupAlert(dbAlert.alert_id);
            console.log(`Auto-resolved (OneDrive, no history): Removed alert ${dbAlert.alert_id}`);
          } else {
            databaseService.resolveBackupAlert(dbAlert.alert_id);
            console.log(
              `Auto-resolved: Marked alert ${dbAlert.alert_id} resolved (${dbAlert.tenant_name} / ${dbAlert.device_name})`
            );
            resolved++;
          }
        } catch (error: any) {
          console.error(`Failed to resolve alert ${dbAlert.alert_id}:`, error.message);
        }
      }
    }

    return { added, updated, resolved, failedCount, notStartedCount, typeBreakdown };
  } catch (error: any) {
    console.error('Error syncing backup alerts:', error);
    throw new Error(`Failed to sync backup alerts: ${error.message}`);
  }
}

// ============================================
// HELPER FUNCTIONS
// ============================================

function getTenantName(alert: BackupAlert): string {
  if (alert.tenant?.name) {
    return alert.tenant.name.replace(/\s*\([^)]*\)/g, '').trim();
  }
  if (alert.details.errorMessage?.context?.tenantName) {
    return alert.details.errorMessage.context.tenantName;
  }
  if (alert.details.error?.fields?.TenantName) {
    return alert.details.error.fields.TenantName;
  }
  if (alert.tenant?.id) {
    return `Tenant ${alert.tenant.id}`;
  }
  return 'Unknown';
}

function getDeviceName(alert: BackupAlert): string {
  return (
    alert.details.resourceName ||
    alert.details.resource?.name ||
    alert.details.error?.fields?.ResourceName ||
    'Unknown Device'
  );
}

function getBackupType(locations?: Array<{ type: string }>): string {
  if (!locations || locations.length === 0) return 'Unknown';
  const type = locations[0].type;
  if (type === 'cloud') return 'Cloud';
  if (type === 'network_share') return 'On-Site';
  return type;
}

function getFailureReason(alert: BackupAlert): string {
  if (alert.details.errorMessage?.context?.cause_str) {
    return alert.details.errorMessage.context.cause_str.substring(0, 200);
  }
  if (alert.details.errorMessage?.reason) {
    const reason = alert.details.errorMessage.reason;
    if (reason === 'SpaceQuotaReachedHard') return 'Storage quota exceeded';
    if (reason === 'ErrorLinuxFailedToMount') return 'Failed to mount backup location';
    if (reason === 'ConnectToPlatformFailedNetwork') return 'Network connection timeout';
    return reason;
  }
  if (alert.details.error?.text) {
    return alert.details.error.text.substring(0, 200);
  }
  return 'Unknown error';
}

function getAlertSubject(alert: BackupAlert, deviceName: string, tenantName: string): string {
  if (alert.type === 'BackupDidNotStart') {
    return `Backup Did Not Start: ${deviceName} - ${tenantName}`;
  }
  if (alert.type === 'ProtectionServiceNotWorking') {
    return `Acronis Protection Service Not Running: ${deviceName} - ${tenantName}`;
  }
  return `Backup Failed: ${deviceName} - ${tenantName}`;
}

function buildAlertDescription(alertData: any, alertType: string): string {
  const typeLabel =
    alertType === 'BackupDidNotStart'
      ? 'Backup Did Not Start'
      : alertType === 'ProtectionServiceNotWorking'
      ? 'Protection Service Not Running'
      : 'Backup Failed';

  return `
<h3>${typeLabel} Alert</h3>
<table border="0" cellpadding="5" cellspacing="0">
  <tr><td><strong>Alert Type:</strong></td><td>${typeLabel}</td></tr>
  <tr><td><strong>Tenant:</strong></td><td>${alertData.tenant_name}</td></tr>
  <tr><td><strong>Device:</strong></td><td>${alertData.device_name}</td></tr>
  <tr><td><strong>Backup Type:</strong></td><td>${alertData.backup_type}</td></tr>
  <tr><td><strong>Failure Reason:</strong></td><td>${alertData.failure_reason}</td></tr>
  <tr><td><strong>Detected At:</strong></td><td>${alertData.failed_at || 'Unknown'}</td></tr>
</table>

<h4>Error Details</h4>
<pre style="background-color:#f5f5f5;padding:10px;border-radius:4px;overflow-x:auto;">${alertData.error_details || 'No additional error details available.'}</pre>

<hr>
<p><em>This ticket was automatically created by the Acronis backup alert sync.</em></p>
  `.trim();
}
