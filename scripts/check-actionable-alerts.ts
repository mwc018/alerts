import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

async function getToken(): Promise<string> {
  const baseUrl = process.env.ACRONIS_BASE_URL!;
  const clientId = process.env.ACRONIS_CLIENT_ID!;
  const clientSecret = process.env.ACRONIS_CLIENT_SECRET!;
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const response = await axios.post(
    `${baseUrl}/api/2/idp/token`,
    'grant_type=client_credentials',
    { headers: { Authorization: `Basic ${credentials}`, 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  return response.data.access_token;
}

async function getTenantName(baseUrl: string, token: string, tenantId: string): Promise<string> {
  try {
    const r = await axios.get(`${baseUrl}/api/2/tenants/${tenantId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return r.data.name || tenantId;
  } catch {
    return tenantId;
  }
}

async function main() {
  const baseUrl = process.env.ACRONIS_BASE_URL!;
  const token = await getToken();
  console.log('Fetching BackupFailed, BackupDidNotStart, ProtectionServiceNotWorking alerts...\n');

  const response = await axios.get(`${baseUrl}/api/alert_manager/v1/alerts`, {
    headers: { Authorization: `Bearer ${token}` },
    params: { type: 'BackupFailed,BackupDidNotStart,ProtectionServiceNotWorking' },
  });

  const alerts: any[] = response.data.items || response.data.alerts || response.data || [];
  console.log(`Total matching alerts from Acronis: ${alerts.length}\n`);

  const wouldTicket: any[] = [];
  const filtered: any[] = [];

  for (const alert of alerts) {
    const tenantName = alert.tenant?.name
      ? alert.tenant.name.replace(/\s*\([^)]*\)/g, '').trim()
      : alert.details?.errorMessage?.context?.tenantName
      || alert.details?.error?.fields?.TenantName
      || (alert.tenant?.id ? await getTenantName(baseUrl, token, alert.tenant.id) : 'Unknown');

    const deviceName = alert.details?.resourceName
      || alert.details?.resource?.name
      || alert.details?.error?.fields?.ResourceName
      || 'Unknown Device';

    const failureReason = alert.details?.errorMessage?.context?.cause_str?.substring(0, 200)
      || alert.details?.errorMessage?.reason
      || alert.details?.error?.text?.substring(0, 200)
      || 'Unknown error';

    const reasonLower = failureReason.toLowerCase();
    const isO365 = failureReason.startsWith('O365Mailbox');
    const isAccessDenied = reasonLower.includes('access denied')
      || reasonLower === 'access is denied'
      || reasonLower === 'access to the file is denied.';
    const isOneDrive = failureReason.startsWith('OD');

    const entry = {
      id: alert.id,
      type: alert.type,
      tenant: tenantName,
      device: deviceName,
      reason: failureReason,
      createdAt: alert.createdAt || alert.created_at,
    };

    if (isO365) {
      filtered.push({ ...entry, filteredBecause: 'O365 Mailbox (noise)' });
    } else if (isAccessDenied) {
      filtered.push({ ...entry, filteredBecause: 'Access denied (noise)' });
    } else if (isOneDrive) {
      filtered.push({ ...entry, filteredBecause: 'OneDrive (no ticket, stored only)' });
    } else {
      wouldTicket.push(entry);
    }
  }

  console.log(`✅ WOULD CREATE A ZOHO TICKET (${wouldTicket.length}):`);
  console.log('─'.repeat(70));
  if (wouldTicket.length === 0) {
    console.log('  None — no actionable alerts currently active.');
  } else {
    for (const a of wouldTicket) {
      console.log(`\n  [${a.type}]`);
      console.log(`  Tenant:  ${a.tenant}`);
      console.log(`  Device:  ${a.device}`);
      console.log(`  Reason:  ${a.reason}`);
      console.log(`  Since:   ${a.createdAt}`);
      console.log(`  ID:      ${a.id}`);
    }
  }

  console.log(`\n🚫 FILTERED OUT (${filtered.length}):`);
  console.log('─'.repeat(70));
  if (filtered.length === 0) {
    console.log('  None.');
  } else {
    for (const a of filtered) {
      console.log(`\n  [${a.type}] ${a.tenant} / ${a.device}`);
      console.log(`  Reason: ${a.filteredBecause}`);
    }
  }
}

main().catch((err) => {
  console.error('Error:', err.response?.data || err.message);
  process.exit(1);
});
