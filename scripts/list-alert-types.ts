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
    {
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    }
  );
  return response.data.access_token;
}

async function main() {
  const baseUrl = process.env.ACRONIS_BASE_URL!;
  console.log('Fetching ALL alerts from Acronis (no type filter)...\n');

  const token = await getToken();
  const response = await axios.get(`${baseUrl}/api/alert_manager/v1/alerts`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  const alerts: any[] = response.data.items || response.data.alerts || response.data || [];
  console.log(`Total alerts found: ${alerts.length}\n`);

  // Count by type
  const typeCounts: Record<string, number> = {};
  for (const alert of alerts) {
    typeCounts[alert.type] = (typeCounts[alert.type] || 0) + 1;
  }

  // Sort by count descending
  const sorted = Object.entries(typeCounts).sort(([, a], [, b]) => b - a);

  console.log('Alert types and counts:');
  console.log('─'.repeat(50));
  for (const [type, count] of sorted) {
    console.log(`  ${String(count).padStart(4)}  ${type}`);
  }

  // Show a sample of each unique type
  console.log('\nSample alert detail per type:');
  console.log('─'.repeat(50));
  const seen = new Set<string>();
  for (const alert of alerts) {
    if (!seen.has(alert.type)) {
      seen.add(alert.type);
      console.log(`\n[${alert.type}]`);
      console.log(`  id:         ${alert.id}`);
      console.log(`  createdAt:  ${alert.createdAt || alert.created_at || 'n/a'}`);
      console.log(`  tenant:     ${alert.tenant?.name || alert.tenant?.id || 'n/a'}`);
      if (alert.details?.errorMessage?.reason) {
        console.log(`  reason:     ${alert.details.errorMessage.reason}`);
      }
      if (alert.details?.errorMessage?.context?.cause_str) {
        console.log(`  cause:      ${alert.details.errorMessage.context.cause_str.substring(0, 120)}`);
      }
      if (alert.details?.error?.text) {
        console.log(`  error:      ${alert.details.error.text.substring(0, 120)}`);
      }
    }
  }
}

main().catch((err) => {
  console.error('Error:', err.response?.data || err.message);
  process.exit(1);
});
