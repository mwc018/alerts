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

  close(): void {
    this.db.close();
  }
}

export default new DatabaseService();
