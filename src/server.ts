import express from 'express';
import cron from 'node-cron';
import { syncBackupAlerts } from './services/backupAlertService.js';
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

// Daily sync at 7:30 AM Central Time
cron.schedule(
  '30 7 * * *',
  async () => {
    console.log(`[${new Date().toISOString()}] Starting daily backup alert sync...`);
    try {
      const result = await syncBackupAlerts();
      console.log(
        `[${new Date().toISOString()}] Sync complete — added: ${result.added}, updated: ${result.updated}, resolved: ${result.resolved} | BackupFailed: ${result.failedCount}, DidNotStart: ${result.notStartedCount}`
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
