import express from 'express';
import path from 'path';
import cookieParser from 'cookie-parser';
import cron from 'node-cron';
import { syncBackupAlerts } from './services/backupAlertService.js';
import { syncStorageQuotaAlerts, takeStorageSnapshots } from './services/storageAlertService.js';
import clientRoutes from './routes/clientRoutes.js';
import authRoutes from './routes/authRoutes.js';
import { requireAuth, requireAuthApi } from './middleware/requireAuth.js';
import databaseService from './services/databaseService.js';
import config from './config/config.js';

if (!config.auth.jwtSecret) {
  console.warn('WARNING: AUTH_SECRET is not set — authentication is disabled. Set it in Render env vars.');
}

// In dist/, __dirname is ./dist — public/ is one level up at the project root
const publicDir = path.resolve(process.cwd(), 'public');

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(express.static(publicDir));

// Auth routes (must come before protected routes)
app.use('/auth', authRoutes);

app.get('/auth/login-page', (_req, res) => {
  res.sendFile(path.join(publicDir, 'login.html'));
});

// Protected routes — only when AUTH_SECRET is configured
const authEnabled = !!config.auth.jwtSecret;

app.use('/api/clients', authEnabled ? requireAuthApi : (_req, _res, next) => next(), clientRoutes);

app.get('/admin', authEnabled ? requireAuth : (_req, _res, next) => next(), (_req, res) => {
  res.sendFile(path.join(publicDir, 'admin.html'));
});

app.get('/data', authEnabled ? requireAuth : (_req, _res, next) => next(), (_req, res) => {
  res.sendFile(path.join(publicDir, 'data.html'));
});

const SAFE_QUERY_RE = /^\s*SELECT\b/i;
const DANGEROUS_RE = /\b(DROP|DELETE|UPDATE|INSERT|CREATE|ALTER|ATTACH|DETACH|PRAGMA|VACUUM|REINDEX)\b/i;

app.post('/api/query', authEnabled ? requireAuthApi : (_req, _res, next) => next(), (req, res) => {
  const sql: string = (req.body?.sql || '').trim();
  if (!sql) { res.status(400).json({ error: 'No SQL provided' }); return; }
  if (!SAFE_QUERY_RE.test(sql)) { res.status(400).json({ error: 'Only SELECT queries are allowed' }); return; }
  if (DANGEROUS_RE.test(sql)) { res.status(400).json({ error: 'Query contains a disallowed keyword' }); return; }
  try {
    const start = Date.now();
    const result = databaseService.runQuery(sql);
    res.json({ ...result, ms: Date.now() - start, capped: result.rows.length === 1000 });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

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
    const [backupResult, storageResult, snapshotCount] = await Promise.all([
      syncBackupAlerts(),
      syncStorageQuotaAlerts(),
      takeStorageSnapshots(),
    ]);
    console.log(
      `[${new Date().toISOString()}] Manual sync complete — backup: added=${backupResult.added} updated=${backupResult.updated} resolved=${backupResult.resolved} | storage: added=${storageResult.added} updated=${storageResult.updated} resolved=${storageResult.resolved} suppressed=${storageResult.suppressed} | snapshots: ${snapshotCount}`
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
      const [backupResult, storageResult, snapshotCount] = await Promise.all([
        syncBackupAlerts(),
        syncStorageQuotaAlerts(),
        takeStorageSnapshots(),
      ]);
      console.log(
        `[${new Date().toISOString()}] Sync complete — backup: added=${backupResult.added} updated=${backupResult.updated} resolved=${backupResult.resolved} | storage: added=${storageResult.added} updated=${storageResult.updated} resolved=${storageResult.resolved} suppressed=${storageResult.suppressed} | snapshots: ${snapshotCount}`
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
