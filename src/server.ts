import express from 'express';
import cron from 'node-cron';
import { syncBackupAlerts } from './services/backupAlertService.js';
import { syncStorageQuotaAlerts } from './services/storageAlertService.js';
import databaseService from './services/databaseService.js';
import config from './config/config.js';

const app = express();

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'acronis-backup-alerts',
    environment: config.server.nodeEnv,
    timestamp: new Date().toISOString(),
  });
});

// Manual trigger — hit /run-sync in a browser to fire the sync immediately
app.get('/run-sync', async (_req, res) => {
  console.log(`[${new Date().toISOString()}] Manual sync triggered via /run-sync`);
  res.json({ status: 'started', message: 'Sync running — check Render logs for results' });
  try {
    const [backupResult, storageResult] = await Promise.all([
      syncBackupAlerts(),
      syncStorageQuotaAlerts(),
    ]);
    console.log(
      `[${new Date().toISOString()}] Manual sync complete — backup: added=${backupResult.added} updated=${backupResult.updated} resolved=${backupResult.resolved} | storage: added=${storageResult.added} updated=${storageResult.updated} resolved=${storageResult.resolved} suppressed=${storageResult.suppressed}`
    );
  } catch (error: any) {
    console.error(`[${new Date().toISOString()}] Manual sync failed:`, error.message);
  }
});

// Daily sync at 7:30 AM Central Time
cron.schedule(
  '30 7 * * *',
  async () => {
    console.log(`[${new Date().toISOString()}] Starting daily backup alert sync...`);
    try {
      const [backupResult, storageResult] = await Promise.all([
        syncBackupAlerts(),
        syncStorageQuotaAlerts(),
      ]);
      console.log(
        `[${new Date().toISOString()}] Sync complete — backup: added=${backupResult.added} updated=${backupResult.updated} resolved=${backupResult.resolved} | storage: added=${storageResult.added} updated=${storageResult.updated} resolved=${storageResult.resolved} suppressed=${storageResult.suppressed}`
      );
    } catch (error: any) {
      console.error(`[${new Date().toISOString()}] Sync failed:`, error.message);
    }
  },
  { timezone: 'America/Chicago' }
);

console.log('Backup alert sync scheduled for 7:30 AM Central Time daily.');

const server = app.listen(config.server.port, () => {
  console.log(`Server running on port ${config.server.port} (${config.server.nodeEnv})`);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received — shutting down...');
  server.close(() => {
    databaseService.close();
    process.exit(0);
  });
});
