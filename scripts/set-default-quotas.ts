// One-time script: set 100 GB cloud storage quota on all tenants that have none.
// Run with: npx tsx scripts/set-default-quotas.ts
import axios from 'axios';
import dotenv from 'dotenv';
dotenv.config();

const BASE_URL = process.env.ACRONIS_BASE_URL!;
const QUOTA_BYTES = 100 * 1024 * 1024 * 1024; // 100 GB

async function getToken(): Promise<string> {
  const creds = Buffer.from(`${process.env.ACRONIS_CLIENT_ID}:${process.env.ACRONIS_CLIENT_SECRET}`).toString('base64');
  const r = await axios.post(`${BASE_URL}/api/2/idp/token`, 'grant_type=client_credentials', {
    headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  return r.data.access_token;
}

async function discoverPartnerUuid(token: string): Promise<string> {
  const headers = { Authorization: `Bearer ${token}` };
  // StorageQuotaAt80 alerts belong to customer tenants, so their tenant.uuid is a customer UUID
  const r = await axios.get(`${BASE_URL}/api/alert_manager/v1/alerts?type=StorageQuotaAt80`, { headers });
  let alerts: any[] = r.data.items || r.data.alerts || [];
  if (!alerts.length) {
    // Fall back to StorageQuotaExceeded
    const r2 = await axios.get(`${BASE_URL}/api/alert_manager/v1/alerts?type=StorageQuotaExceeded`, { headers });
    alerts = r2.data.items || r2.data.alerts || [];
  }
  if (!alerts.length) throw new Error('No storage quota alerts found — cannot discover partner UUID');
  const customerUuid = alerts[0].tenant?.uuid;
  const tenantResp = await axios.get(`${BASE_URL}/api/2/tenants/${customerUuid}`, { headers });
  return tenantResp.data.parent_id;
}

async function main() {
  const token = await getToken();
  const headers = { Authorization: `Bearer ${token}` };
  const partnerUuid = await discoverPartnerUuid(token);
  console.log(`Partner UUID: ${partnerUuid}\n`);

  // Page through all customer tenants
  const allTenants: any[] = [];
  let after = '';
  do {
    const params: any = { parent_id: partnerUuid, kind: 'customer' };
    if (after) params.after = after;
    const r = await axios.get(`${BASE_URL}/api/2/tenants`, { headers, params });
    allTenants.push(...(r.data.items || []));
    after = r.data.paging?.cursors?.after || '';
  } while (after);
  console.log(`Found ${allTenants.length} customer tenants\n`);

  let applied = 0, skipped = 0, errors = 0;

  for (const tenant of allTenants) {
    try {
      // Cloud storage quotas live on infra-type usage items; read usages to find them
      const usageResp = await axios.get(`${BASE_URL}/api/2/tenants/${tenant.id}/usages`, { headers });
      const usages: any[] = usageResp.data.items || [];

      const infraStorage = usages.filter(
        (i: any) => i.type === 'infra' && i.measurement_unit === 'bytes' && i.usage_name === 'storage'
      );

      // Only update items that have no quota currently
      const noQuotaItems = infraStorage.filter((i: any) => !i.offering_item?.quota?.value);

      if (noQuotaItems.length === 0) {
        console.log(`SKIP  ${tenant.name}`);
        skipped++;
        continue;
      }

      const offeringItems = noQuotaItems.map((item: any) => ({
        application_id: item.application_id,
        name: item.name,
        edition: item.edition,
        usage_name: item.usage_name,
        type: item.type,
        infra_id: item.infra_id,
        measurement_unit: item.measurement_unit,
        status: item.offering_item?.status ?? 1,
        locked: false,
        quota: { value: QUOTA_BYTES, overage: null, version: item.offering_item?.quota?.version ?? 0 },
      }));

      await axios.put(`${BASE_URL}/api/2/tenants/${tenant.id}/offering_items`, { offering_items: offeringItems }, { headers });

      console.log(`SET   ${tenant.name}`);
      applied++;
    } catch (err: any) {
      console.error(`ERROR ${tenant.name}: ${err.response?.data?.message || err.message}`);
      errors++;
    }
  }

  console.log(`\nDone — set: ${applied}  skipped (already had quota): ${skipped}  errors: ${errors}`);
}

main().catch((e: any) => { console.error(e.response?.data || e.message); process.exit(1); });
