import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import config from '../config/config.js';

class DatabaseService {
  private db: Database.Database;

  constructor() {
    const dbPath = config.database.path;
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.initialize();
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS backup_alerts (
        alert_id TEXT PRIMARY KEY,
        alert_type TEXT,
        tenant_id TEXT,
        tenant_name TEXT,
        device_name TEXT,
        backup_type TEXT,
        failure_reason TEXT,
        error_details TEXT,
        failed_at TEXT,
        status TEXT NOT NULL DEFAULT 'Open',
        assigned_to TEXT,
        assigned_at TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        resolved_at TEXT,
        zoho_ticket_id TEXT,
        zoho_ticket_number TEXT,
        zoho_ticket_url TEXT,
        alert_data TEXT
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS clients (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        site_name TEXT NOT NULL UNIQUE,
        client_email TEXT,
        zoho_account_id TEXT,
        zoho_account_name TEXT,
        client_engineer TEXT,
        zoho_engineer_id TEXT,
        storage_threshold INTEGER NOT NULL DEFAULT 80,
        notes TEXT,
        tenant_id TEXT,
        tenant_uuid TEXT,
        percent_used INTEGER DEFAULT 0,
        used_bytes INTEGER DEFAULT 0,
        quota_bytes INTEGER DEFAULT 0,
        used_formatted TEXT,
        quota_formatted TEXT,
        alert_type TEXT DEFAULT 'None',
        last_synced_at TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);

    // Migrate existing clients tables that are missing the storage columns
    const clientCols = (this.db.pragma('table_info(clients)') as Array<{ name: string }>).map((r) => r.name);
    for (const [col, def] of [
      ['tenant_id', 'TEXT'],
      ['tenant_uuid', 'TEXT'],
      ['percent_used', 'INTEGER DEFAULT 0'],
      ['used_bytes', 'INTEGER DEFAULT 0'],
      ['quota_bytes', 'INTEGER DEFAULT 0'],
      ['used_formatted', 'TEXT'],
      ['quota_formatted', 'TEXT'],
      ['alert_type', "TEXT DEFAULT 'None'"],
      ['last_synced_at', 'TEXT'],
      ['total_used_bytes', 'INTEGER DEFAULT 0'],
      ['total_used_formatted', 'TEXT'],
    ] as [string, string][]) {
      if (!clientCols.includes(col)) {
        this.db.exec(`ALTER TABLE clients ADD COLUMN ${col} ${def}`);
      }
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS storage_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_uuid TEXT NOT NULL,
        site_name TEXT NOT NULL,
        percent_used INTEGER NOT NULL DEFAULT 0,
        used_bytes INTEGER NOT NULL DEFAULT 0,
        quota_bytes INTEGER NOT NULL DEFAULT 0,
        used_formatted TEXT,
        quota_formatted TEXT,
        total_used_bytes INTEGER DEFAULT 0,
        total_used_formatted TEXT,
        alert_type TEXT DEFAULT 'None',
        snapshot_date TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(tenant_uuid, snapshot_date)
      )
    `);

    const histCols = (this.db.pragma('table_info(storage_history)') as Array<{ name: string }>).map((r) => r.name);
    for (const [col, def] of [
      ['total_used_bytes', 'INTEGER DEFAULT 0'],
      ['total_used_formatted', 'TEXT'],
    ] as [string, string][]) {
      if (!histCols.includes(col)) {
        this.db.exec(`ALTER TABLE storage_history ADD COLUMN ${col} ${def}`);
      }
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS storage_quota_alerts (
        alert_id TEXT PRIMARY KEY,
        alert_type TEXT NOT NULL,
        tenant_id TEXT,
        tenant_uuid TEXT,
        tenant_name TEXT,
        storage_type TEXT,
        percent_used INTEGER,
        used_bytes INTEGER,
        quota_bytes INTEGER,
        threshold_pct INTEGER,
        alerted_at TEXT,
        status TEXT NOT NULL DEFAULT 'Open',
        created_at TEXT DEFAULT (datetime('now')),
        resolved_at TEXT,
        zoho_ticket_id TEXT,
        zoho_ticket_number TEXT,
        zoho_ticket_url TEXT
      )
    `);

    // Run migrations for any existing databases missing the newer columns
    const cols = (this.db.pragma('table_info(backup_alerts)') as Array<{ name: string }>)
      .map((r) => r.name);

    if (!cols.includes('zoho_ticket_id')) {
      this.db.exec(`ALTER TABLE backup_alerts ADD COLUMN zoho_ticket_id TEXT`);
    }
    if (!cols.includes('zoho_ticket_number')) {
      this.db.exec(`ALTER TABLE backup_alerts ADD COLUMN zoho_ticket_number TEXT`);
    }
    if (!cols.includes('zoho_ticket_url')) {
      this.db.exec(`ALTER TABLE backup_alerts ADD COLUMN zoho_ticket_url TEXT`);
    }
    if (!cols.includes('alert_type')) {
      this.db.exec(`ALTER TABLE backup_alerts ADD COLUMN alert_type TEXT`);
    }
  }

  upsertBackupAlert(data: {
    alert_id: string;
    alert_type: string;
    tenant_id: string;
    tenant_name: string;
    device_name: string;
    backup_type: string;
    failure_reason: string;
    error_details: string;
    failed_at?: string;
    alert_data: string;
  }): void {
    const existing = this.db
      .prepare('SELECT * FROM backup_alerts WHERE alert_id = ?')
      .get(data.alert_id) as any;

    if (existing) {
      if (existing.resolved_at) return; // already resolved — leave it alone
      this.db
        .prepare(
          `UPDATE backup_alerts
           SET alert_type = ?, failed_at = ?, error_details = ?, alert_data = ?
           WHERE alert_id = ?`
        )
        .run(data.alert_type, data.failed_at, data.error_details, data.alert_data, data.alert_id);
    } else {
      this.db
        .prepare(
          `INSERT INTO backup_alerts
             (alert_id, alert_type, tenant_id, tenant_name, device_name, backup_type,
              failure_reason, error_details, failed_at, alert_data)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          data.alert_id,
          data.alert_type,
          data.tenant_id,
          data.tenant_name,
          data.device_name,
          data.backup_type,
          data.failure_reason,
          data.error_details,
          data.failed_at,
          data.alert_data
        );
    }
  }

  getAllBackupAlerts(includeResolved = false): any[] {
    const sql = includeResolved
      ? 'SELECT * FROM backup_alerts ORDER BY failed_at DESC'
      : 'SELECT * FROM backup_alerts WHERE resolved_at IS NULL ORDER BY failed_at DESC';
    return this.db.prepare(sql).all();
  }

  getBackupAlert(alertId: string): any {
    return this.db.prepare('SELECT * FROM backup_alerts WHERE alert_id = ?').get(alertId);
  }

  updateBackupAlertZohoTicket(
    alertId: string,
    zohoTicketId: string,
    zohoTicketNumber: string,
    zohoTicketUrl: string
  ): void {
    this.db
      .prepare(
        `UPDATE backup_alerts
         SET zoho_ticket_id = ?, zoho_ticket_number = ?, zoho_ticket_url = ?
         WHERE alert_id = ?`
      )
      .run(zohoTicketId, zohoTicketNumber, zohoTicketUrl, alertId);
  }

  updateBackupAlertStatus(alertId: string, status: string, assignedTo?: string): void {
    if (assignedTo !== undefined) {
      this.db
        .prepare(
          `UPDATE backup_alerts SET status = ?, assigned_to = ?, assigned_at = datetime('now') WHERE alert_id = ?`
        )
        .run(status, assignedTo, alertId);
    } else {
      this.db
        .prepare('UPDATE backup_alerts SET status = ? WHERE alert_id = ?')
        .run(status, alertId);
    }
  }

  resolveBackupAlert(alertId: string): void {
    this.db
      .prepare(`UPDATE backup_alerts SET resolved_at = datetime('now'), status = 'Resolved' WHERE alert_id = ?`)
      .run(alertId);
  }

  deleteBackupAlert(alertId: string): void {
    this.db.prepare('DELETE FROM backup_alerts WHERE alert_id = ?').run(alertId);
  }

  // ── Client mappings ───────────────────────────────────────────────────

  getAllClients(): any[] {
    return this.db.prepare('SELECT * FROM clients ORDER BY site_name ASC').all();
  }

  getClientById(id: number): any {
    return this.db.prepare('SELECT * FROM clients WHERE id = ?').get(id);
  }

  lookupClientBySiteName(siteName: string): any {
    // Tier 1: exact match
    let row = this.db.prepare('SELECT * FROM clients WHERE site_name = ?').get(siteName) as any;
    if (row) return row;
    // Tier 2: case-insensitive
    row = this.db.prepare('SELECT * FROM clients WHERE LOWER(site_name) = LOWER(?)').get(siteName) as any;
    if (row) return row;
    // Tier 3: substring — site_name contains siteName or siteName contains site_name
    const all = this.db.prepare('SELECT * FROM clients').all() as any[];
    const lower = siteName.toLowerCase();
    return all.find(
      (c) => c.site_name.toLowerCase().includes(lower) || lower.includes(c.site_name.toLowerCase())
    ) || null;
  }

  createClient(data: {
    site_name: string;
    client_email?: string;
    zoho_account_id?: string;
    zoho_account_name?: string;
    client_engineer?: string;
    zoho_engineer_id?: string;
    storage_threshold?: number;
    notes?: string;
  }): any {
    const result = this.db
      .prepare(
        `INSERT INTO clients
           (site_name, client_email, zoho_account_id, zoho_account_name,
            client_engineer, zoho_engineer_id, storage_threshold, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        data.site_name,
        data.client_email || null,
        data.zoho_account_id || null,
        data.zoho_account_name || null,
        data.client_engineer || null,
        data.zoho_engineer_id || null,
        data.storage_threshold ?? 80,
        data.notes || null
      );
    return this.getClientById(result.lastInsertRowid as number);
  }

  updateClient(
    id: number,
    data: {
      site_name?: string;
      client_email?: string;
      zoho_account_id?: string;
      zoho_account_name?: string;
      client_engineer?: string;
      zoho_engineer_id?: string;
      storage_threshold?: number;
      notes?: string;
    }
  ): any {
    const existing = this.getClientById(id);
    if (!existing) return null;
    this.db
      .prepare(
        `UPDATE clients SET
           site_name = ?, client_email = ?, zoho_account_id = ?, zoho_account_name = ?,
           client_engineer = ?, zoho_engineer_id = ?, storage_threshold = ?, notes = ?,
           updated_at = datetime('now')
         WHERE id = ?`
      )
      .run(
        data.site_name ?? existing.site_name,
        data.client_email ?? existing.client_email,
        data.zoho_account_id ?? existing.zoho_account_id,
        data.zoho_account_name ?? existing.zoho_account_name,
        data.client_engineer ?? existing.client_engineer,
        data.zoho_engineer_id ?? existing.zoho_engineer_id,
        data.storage_threshold ?? existing.storage_threshold,
        data.notes ?? existing.notes,
        id
      );
    return this.getClientById(id);
  }

  deleteClient(id: number): boolean {
    const result = this.db.prepare('DELETE FROM clients WHERE id = ?').run(id);
    return result.changes > 0;
  }

  upsertClientFromAcronis(data: {
    tenant_id: string;
    tenant_uuid: string;
    site_name: string;
    percent_used: number;
    used_bytes: number;
    quota_bytes: number;
    used_formatted: string;
    quota_formatted: string;
    total_used_bytes: number;
    total_used_formatted: string;
    alert_type: string;
  }): any {
    const now = new Date().toISOString();
    const existing = this.lookupClientBySiteName(data.site_name);

    if (existing) {
      this.db
        .prepare(
          `UPDATE clients SET
             tenant_id = ?, tenant_uuid = ?,
             percent_used = ?, used_bytes = ?, quota_bytes = ?,
             used_formatted = ?, quota_formatted = ?,
             total_used_bytes = ?, total_used_formatted = ?,
             alert_type = ?, last_synced_at = ?,
             updated_at = datetime('now')
           WHERE id = ?`
        )
        .run(
          data.tenant_id, data.tenant_uuid,
          data.percent_used, data.used_bytes, data.quota_bytes,
          data.used_formatted, data.quota_formatted,
          data.total_used_bytes, data.total_used_formatted,
          data.alert_type, now,
          existing.id
        );
      return this.getClientById(existing.id);
    } else {
      const result = this.db
        .prepare(
          `INSERT INTO clients
             (site_name, tenant_id, tenant_uuid,
              percent_used, used_bytes, quota_bytes,
              used_formatted, quota_formatted,
              total_used_bytes, total_used_formatted,
              alert_type, last_synced_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          data.site_name, data.tenant_id, data.tenant_uuid,
          data.percent_used, data.used_bytes, data.quota_bytes,
          data.used_formatted, data.quota_formatted,
          data.total_used_bytes, data.total_used_formatted,
          data.alert_type, now
        );
      return this.getClientById(result.lastInsertRowid as number);
    }
  }

  // ── Storage history snapshots ────────────────────────────────────────

  insertStorageSnapshot(data: {
    tenant_uuid: string;
    site_name: string;
    percent_used: number;
    used_bytes: number;
    quota_bytes: number;
    used_formatted: string;
    quota_formatted: string;
    total_used_bytes: number;
    total_used_formatted: string;
    alert_type: string;
  }): void {
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    this.db
      .prepare(
        `INSERT INTO storage_history
           (tenant_uuid, site_name, percent_used, used_bytes, quota_bytes,
            used_formatted, quota_formatted,
            total_used_bytes, total_used_formatted,
            alert_type, snapshot_date)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(tenant_uuid, snapshot_date) DO UPDATE SET
           percent_used        = excluded.percent_used,
           used_bytes          = excluded.used_bytes,
           quota_bytes         = excluded.quota_bytes,
           used_formatted      = excluded.used_formatted,
           quota_formatted     = excluded.quota_formatted,
           total_used_bytes    = excluded.total_used_bytes,
           total_used_formatted = excluded.total_used_formatted,
           alert_type          = excluded.alert_type`
      )
      .run(
        data.tenant_uuid, data.site_name,
        data.percent_used, data.used_bytes, data.quota_bytes,
        data.used_formatted, data.quota_formatted,
        data.total_used_bytes, data.total_used_formatted,
        data.alert_type, today
      );
  }

  getStorageHistory(tenantUuid?: string, days = 90): any[] {
    if (tenantUuid) {
      return this.db
        .prepare(
          `SELECT * FROM storage_history
           WHERE tenant_uuid = ?
             AND snapshot_date >= date('now', ? || ' days')
           ORDER BY snapshot_date ASC`
        )
        .all(tenantUuid, `-${days}`);
    }
    return this.db
      .prepare(
        `SELECT * FROM storage_history
         WHERE snapshot_date >= date('now', ? || ' days')
         ORDER BY site_name ASC, snapshot_date ASC`
      )
      .all(`-${days}`);
  }

  // ── Storage quota alerts ──────────────────────────────────────────────

  upsertStorageQuotaAlert(data: {
    alert_id: string;
    alert_type: string;
    tenant_id: string;
    tenant_uuid: string;
    tenant_name: string;
    storage_type: string;
    percent_used: number;
    used_bytes: number;
    quota_bytes: number;
    threshold_pct: number;
    alerted_at: string;
  }): void {
    const existing = this.db
      .prepare('SELECT * FROM storage_quota_alerts WHERE alert_id = ?')
      .get(data.alert_id) as any;

    if (existing) {
      if (existing.resolved_at) return;
      this.db
        .prepare(
          `UPDATE storage_quota_alerts
           SET percent_used = ?, used_bytes = ?, quota_bytes = ?, alerted_at = ?
           WHERE alert_id = ?`
        )
        .run(data.percent_used, data.used_bytes, data.quota_bytes, data.alerted_at, data.alert_id);
    } else {
      this.db
        .prepare(
          `INSERT INTO storage_quota_alerts
             (alert_id, alert_type, tenant_id, tenant_uuid, tenant_name, storage_type,
              percent_used, used_bytes, quota_bytes, threshold_pct, alerted_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          data.alert_id, data.alert_type, data.tenant_id, data.tenant_uuid,
          data.tenant_name, data.storage_type, data.percent_used, data.used_bytes,
          data.quota_bytes, data.threshold_pct, data.alerted_at
        );
    }
  }

  getAllStorageQuotaAlerts(includeResolved = false): any[] {
    const sql = includeResolved
      ? 'SELECT * FROM storage_quota_alerts ORDER BY percent_used DESC'
      : 'SELECT * FROM storage_quota_alerts WHERE resolved_at IS NULL ORDER BY percent_used DESC';
    return this.db.prepare(sql).all();
  }

  updateStorageQuotaAlertZohoTicket(
    alertId: string,
    zohoTicketId: string,
    zohoTicketNumber: string,
    zohoTicketUrl: string
  ): void {
    this.db
      .prepare(
        `UPDATE storage_quota_alerts
         SET zoho_ticket_id = ?, zoho_ticket_number = ?, zoho_ticket_url = ?
         WHERE alert_id = ?`
      )
      .run(zohoTicketId, zohoTicketNumber, zohoTicketUrl, alertId);
  }

  resolveStorageQuotaAlert(alertId: string): void {
    this.db
      .prepare(
        `UPDATE storage_quota_alerts
         SET resolved_at = datetime('now'), status = 'Resolved'
         WHERE alert_id = ?`
      )
      .run(alertId);
  }

  runQuery(sql: string): { columns: string[]; rows: any[][] } {
    const stmt = this.db.prepare(sql);
    const raw = stmt.all() as Record<string, any>[];
    if (raw.length === 0) return { columns: [], rows: [] };
    const columns = Object.keys(raw[0]);
    const rows = raw.slice(0, 1000).map((r) => columns.map((c) => r[c]));
    return { columns, rows };
  }

  close(): void {
    this.db.close();
  }
}

export default new DatabaseService();
