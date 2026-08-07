const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { app } = require('electron');
const { hashPassword } = require('../security');
const { RECOVERY_GRACE_SEC_DEFAULT } = require('../constants');

let db;

function init() {
  close();
  const dir = app.getPath('userData');
  const file = path.join(dir, 'voltdesk.db');
  db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);
  runMigrations();
  seedDefaults();
  const integrity = checkIntegrity();
  runAutoBackup(file);
  return { db, integrity };
}

function checkIntegrity() {
  try {
    const row = db.pragma('integrity_check');
    const ok = Array.isArray(row) ? row.every((r) => r.integrity_check === 'ok') : row === 'ok';
    return ok ? 'ok' : 'corrupt';
  } catch (e) {
    return String(e.message || e);
  }
}

function runAutoBackup(dbFile) {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const settings = getSettings();
    if (settings.last_backup_date === today) return;
    const backupsDir = path.join(app.getPath('userData'), 'backups');
    fs.mkdirSync(backupsDir, { recursive: true });
    try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch (e) { /* ignore */ }
    const dest = path.join(backupsDir, `voltdesk-${today}.db`);
    fs.copyFileSync(dbFile, dest);
    const backups = fs
      .readdirSync(backupsDir)
      .filter((f) => /^voltdesk-\d{4}-\d{2}-\d{2}\.db$/.test(f))
      .sort()
      .reverse();
    for (const old of backups.slice(7)) {
      try { fs.unlinkSync(path.join(backupsDir, old)); } catch (e) { /* ignore */ }
    }
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run('last_backup_date', today);
  } catch (e) { /* backup failure is non-fatal */ }
}

function close() {
  if (db && db.open) {
    try { db.close(); } catch (e) { /* ignore */ }
  }
}

function runMigrations() {
  const migrations = [
    `ALTER TABLE bills ADD COLUMN service_fee REAL DEFAULT 0`,
    `ALTER TABLE bills ADD COLUMN service_charge REAL DEFAULT 0`,
    `ALTER TABLE bills ADD COLUMN soc_start INTEGER`,
    `ALTER TABLE bills ADD COLUMN soc_end INTEGER`,
    `ALTER TABLE bills ADD COLUMN rate_name TEXT`,
    `ALTER TABLE bills ADD COLUMN customer_id TEXT`,
    `ALTER TABLE bills ADD COLUMN customer_name TEXT`,
    `ALTER TABLE bills ADD COLUMN customer_pan TEXT`,
    `ALTER TABLE bills ADD COLUMN customer_address TEXT`,
    `ALTER TABLE bills ADD COLUMN customer_vehicle TEXT`,
    `ALTER TABLE transactions ADD COLUMN customer_id TEXT`,
    `ALTER TABLE transactions ADD COLUMN customer_name TEXT`,
    `ALTER TABLE transactions ADD COLUMN customer_pan TEXT`,
    `ALTER TABLE transactions ADD COLUMN customer_address TEXT`,
    `ALTER TABLE transactions ADD COLUMN customer_vehicle TEXT`,
    `ALTER TABLE transactions ADD COLUMN flagged INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE transactions ADD COLUMN flag_reason TEXT`,
    `ALTER TABLE transactions ADD COLUMN billed INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE bills ADD COLUMN synced INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE transactions ADD COLUMN synced INTEGER NOT NULL DEFAULT 0`,
    `DELETE FROM bills WHERE id NOT IN (SELECT MIN(id) FROM bills GROUP BY transaction_id)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_bills_transaction ON bills(transaction_id)`,
    `UPDATE transactions SET billed = 1 WHERE billed = 0 AND id IN (SELECT transaction_id FROM bills)`,
    `ALTER TABLE transactions ADD COLUMN max_power_kw REAL`,
    `ALTER TABLE transactions ADD COLUMN avg_power_kw REAL`,
    `ALTER TABLE transactions ADD COLUMN last_power_kw REAL`,
    `ALTER TABLE bills ADD COLUMN max_power_kw REAL`,
    `ALTER TABLE bills ADD COLUMN avg_power_kw REAL`,
    `ALTER TABLE bills ADD COLUMN last_power_kw REAL`,
    `ALTER TABLE transactions ADD COLUMN meter_energy_start_kwh REAL`,
    `ALTER TABLE transactions ADD COLUMN meter_energy_end_kwh REAL`,
    `ALTER TABLE bills ADD COLUMN meter_energy_start_kwh REAL`,
    `ALTER TABLE bills ADD COLUMN meter_energy_end_kwh REAL`,
    `ALTER TABLE transactions ADD COLUMN server_data TEXT`,
    `ALTER TABLE bills ADD COLUMN server_bill_id TEXT`,
  ];
  for (const sql of migrations) {
    try { db.exec(sql); } catch (e) { /* column may already exist */ }
  }
  backfillTransactionTimes();
  backfillMeterAnchorsFromLogs();
  const missingKeys = {
    branding_logo: '',
    invoice_logo: '',
    show_logo_on_bill: '1',
    use_new_bill_format: '0',
    bill_display_format: 'professional',
    service_fee: '0',
    service_charge: '0',
    company_address: '',
    company_phone: '',
    company_email: '',
    company_footer: '',
    api_customer_search_endpoint: '',
    api_company_info_endpoint: '',
    api_bill_format_endpoint: '',
    api_bill_details_endpoint: '',
    api_bill_number_endpoint: '',
    api_login_endpoint: '',
    api_username: '',
    api_password: '',
    api_token: '',
    api_token_expires_at: '',
    printer_type: 'system',
    thermal_print_mode: 'raster',
    printer_network_ip: '',
    printer_network_port: '9100',
    printer_bt_com: '',
    bt_printer_address: '',
    bt_printer_name: '',
    paper_width: '',
    security_password: '',
    auto_lock: '1',
    lock_on_startup: '1',
    recovery_grace_sec: RECOVERY_GRACE_SEC_DEFAULT
  };
  const insert = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(missingKeys)) {
    try { insert.run(k, v); } catch (e) { /* ignore */ }
  }
  migratePassword();
}

// One-time repair for historical sessions. The server never sends absolute
// transaction times (transaction_started carries no timestamp and the summary's
// started_at/ended_at are actually SoC values), so the app used to stamp
// receipt times, producing multi-day windows when it was offline. The session
// duration is the only trustworthy value, so every stopped transaction is
// re-anchored: prefer the matching transaction_started receipt time, else the
// earliest snapshot showing that ocpp_tx_id backdated by its elapsed_sec, and
// derive the stop from start + duration. Also backfills the cumulative meter
// counter at session start/end: the counter at session start is invariant
// during the session and equals meter.energy - session.energy, so
// end - start equals the delivered (billed) kWh. Finally each transaction gets
// server_data - the full latest server payload - so no server field is lost.
function backfillTransactionTimes() {
  const marker = 'backfill_tx_times_v3';
  const done = db.prepare('SELECT value FROM settings WHERE key = ?').get(marker);
  if (done) return;

  const toFinite = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const parseIso = (s) => {
    const t = s && Date.parse(s);
    return Number.isFinite(t) ? new Date(t) : null;
  };
  const upsertMarker = db
    .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  const toleranceSec = 120;
  const lookbackMs = 60 * 60 * 1000;

  const txRows = db
    .prepare(
      `SELECT id, charger_id, connector_id, ocpp_tx_id, started_at, stopped_at, duration_sec, energy_kwh
       FROM transactions WHERE status = 'stopped'`
    )
    .all();
  const startedLogs = db.prepare(
    `SELECT ts FROM logs WHERE charger_id = ? AND type = 'transaction_started'
       AND json_extract(payload, '$.connector_id') = ?
       AND json_extract(payload, '$.transaction_id') = ?`
  );
  const snapshotLogs = db.prepare(
    `SELECT ts, payload FROM logs WHERE charger_id = ? AND type = 'snapshot'
       AND ts >= ? AND ts <= ? ORDER BY ts`
  );
  const meterLogs = db.prepare(
    `SELECT payload FROM logs WHERE charger_id = ? AND type = 'meter'
       AND ts >= ? AND ts <= ? ORDER BY ts`
  );
  const updateTx = db.prepare(
    `UPDATE transactions SET started_at = ?, stopped_at = ?,
       meter_energy_start_kwh = ?, meter_energy_end_kwh = ?, server_data = ? WHERE id = ?`
  );
  const stoppedPayload = db.prepare(
    `SELECT payload FROM logs WHERE charger_id = ? AND type = 'transaction_stopped'
       AND json_extract(payload, '$.connector_id') = ?
       AND json_extract(payload, '$.transaction_id') = ?
       AND ts >= ? AND ts <= ? ORDER BY ts DESC LIMIT 1`
  );

  const run = db.transaction(() => {
    for (const tx of txRows) {
      const dur = toFinite(tx.duration_sec);
      const start = parseIso(tx.started_at);
      if (dur == null || dur <= 0 || !start) continue;

      let newStart = start;
      const logRows = startedLogs.all(tx.charger_id, tx.connector_id, tx.ocpp_tx_id);
      let nearest = null;
      let nearestDiff = null;
      for (const row of logRows) {
        const t = parseIso(row.ts);
        if (!t) continue;
        const diff = Math.abs(t.getTime() - start.getTime()) / 1000;
        if (nearestDiff == null || diff < nearestDiff) {
          nearestDiff = diff;
          nearest = t;
        }
      }
      if (nearest == null || nearestDiff > toleranceSec) {
        // Fall back to the earliest snapshot showing this ocpp_tx_id,
        // anchored by its elapsed_sec. ocpp_tx_id is reused per connector, so
        // the search is bounded to [start - 1h, stop].
        const stop = parseIso(tx.stopped_at) || new Date();
        const snaps = snapshotLogs.all(
          tx.charger_id,
          new Date(start.getTime() - lookbackMs).toISOString(),
          stop.toISOString()
        );
        let best = null;
        for (const snap of snaps) {
          let parsed = null;
          try { parsed = JSON.parse(snap.payload); } catch (e) { continue; }
          const conn = parsed.connectors && parsed.connectors[String(tx.connector_id)];
          const snapTx = conn && conn.transaction;
          if (!snapTx || snapTx.transaction_id !== tx.ocpp_tx_id) continue;
          const elapsed = toFinite(snapTx.elapsed_sec);
          const snapTs = parseIso(snap.ts);
          if (elapsed == null || !snapTs) continue;
          const cand = new Date(snapTs.getTime() - elapsed * 1000);
          if (best == null || cand < best) best = cand;
        }
        if (best != null) newStart = best;
      }
      const newStop = new Date(newStart.getTime() + dur * 1000);

      let meterStart = null;
      let meterEnd = null;
      let serverData = null;
      for (const m of meterLogs.all(
        tx.charger_id,
        new Date(newStart.getTime() - 30000).toISOString(),
        new Date(newStop.getTime() + 60000).toISOString()
      )) {
        let parsed = null;
        try { parsed = JSON.parse(m.payload); } catch (e) { continue; }
        if (parsed.connector_id !== tx.connector_id) continue;
        serverData = m.payload;
        const e = toFinite(parsed.meter && parsed.meter.energy);
        if (e == null) continue;
        // Counter at session start: invariant for the whole session, derivable
        // from any reading that carries the delivered session energy.
        if (meterStart == null) {
          const sessE = toFinite(parsed.session && parsed.session.energy);
          if (sessE != null) meterStart = e - sessE;
        }
      }
      // Meter end is anchored to the billed energy so the receipt always
      // reconciles: meter_end - meter_start == energy_kwh. (The last meter log
      // can trail the true session end, e.g. when the app missed the final
      // readings, so the raw last reading would under-report.)
      const billed = toFinite(tx.energy_kwh);
      if (meterStart == null || billed == null) {
        meterStart = null;
        meterEnd = null;
      } else {
        meterEnd = meterStart + billed;
      }
      // Preserve the full server payload with the session: prefer the last
      // meter reading, else the stopped summary, else the started event.
      if (serverData == null) {
        const stopped = stoppedPayload.get(
          tx.charger_id,
          tx.connector_id,
          tx.ocpp_tx_id,
          new Date(newStart.getTime() - 60000).toISOString(),
          new Date(newStop.getTime() + 300000).toISOString()
        );
        if (stopped) serverData = stopped.payload;
      }
      if (serverData == null && logRows.length > 0) {
        serverData = db.prepare(
          `SELECT payload FROM logs WHERE charger_id = ? AND type = 'transaction_started'
             AND json_extract(payload, '$.connector_id') = ?
             AND json_extract(payload, '$.transaction_id') = ? ORDER BY ts DESC LIMIT 1`
        ).get(tx.charger_id, tx.connector_id, tx.ocpp_tx_id).payload;
      }

      updateTx.run(
        newStart.toISOString(),
        newStop.toISOString(),
        meterStart,
        meterEnd,
        serverData,
        tx.id
      );
    }
    upsertMarker.run(marker, new Date().toISOString());
  });
  try {
    run();
  } catch (e) { /* backfill failure is non-fatal */ }
}

// Fill meter-counter anchors for sessions that predate the server sending
// energy on transaction_started. Only rows with no start anchor are touched -
// already-anchored receipts stay as printed. The server's own counters win
// when the logs carry them (started event top-level energy = counter at
// session start, stopped summary energy = counter at stop); otherwise keep
// the self-consistent start + billed window.
function backfillMeterAnchorsFromLogs() {
  const marker = 'backfill_tx_meter_anchors_v1';
  const done = db.prepare('SELECT value FROM settings WHERE key = ?').get(marker);
  if (done) return;

  const toFinite = (v) => {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const upsertMarker = db
    .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');

  const startedLog = db.prepare(
    `SELECT payload FROM logs WHERE charger_id = ? AND type = 'transaction_started'
       AND json_extract(payload, '$.connector_id') = ?
       AND json_extract(payload, '$.transaction_id') = ? ORDER BY ts DESC, id DESC LIMIT 1`
  );
  const stoppedLog = db.prepare(
    `SELECT payload FROM logs WHERE charger_id = ? AND type = 'transaction_stopped'
       AND json_extract(payload, '$.connector_id') = ?
       AND json_extract(payload, '$.transaction_id') = ? ORDER BY ts DESC, id DESC LIMIT 1`
  );
  const updateTx = db.prepare(
    'UPDATE transactions SET meter_energy_start_kwh = ?, meter_energy_end_kwh = ? WHERE id = ?'
  );

  const rows = db
    .prepare(
      `SELECT id, charger_id, connector_id, ocpp_tx_id, energy_kwh
       FROM transactions WHERE status = 'stopped' AND meter_energy_start_kwh IS NULL`
    )
    .all();

  const run = db.transaction(() => {
    for (const tx of rows) {
      if (tx.charger_id == null || tx.connector_id == null || tx.ocpp_tx_id == null) continue;
      let start = null;
      let end = null;
      const startedRow = startedLog.get(tx.charger_id, tx.connector_id, tx.ocpp_tx_id);
      if (startedRow) {
        try {
          const payload = JSON.parse(startedRow.payload);
          start = toFinite(payload && payload.energy);
        } catch (e) { /* ignore malformed payload */ }
      }
      const stoppedRow = stoppedLog.get(tx.charger_id, tx.connector_id, tx.ocpp_tx_id);
      if (stoppedRow) {
        try {
          const payload = JSON.parse(stoppedRow.payload);
          end = toFinite(payload && payload.summary && payload.summary.energy);
        } catch (e) { /* ignore malformed payload */ }
      }
      const billed = toFinite(tx.energy_kwh);
      if (start == null && end != null && billed != null) start = end - billed;
      if (end == null && start != null && billed != null) end = start + billed;
      if (start == null && end == null) continue;
      updateTx.run(start, end, tx.id);
    }
    upsertMarker.run(marker, new Date().toISOString());
  });
  try {
    run();
  } catch (e) { /* backfill failure is non-fatal */ }
}

function migratePassword() {
  const get = (key) => {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : null;
  };
  const set = (key, value) =>
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  const pinCode = get('pin_code');
  const stored = get('security_password') || '';
  if (!stored) {
    set('security_password', hashPassword(pinCode || 'admin'));
  }
  if (pinCode != null) {
    db.prepare('DELETE FROM settings WHERE key = ?').run('pin_code');
  }
}

function seedDefaults() {
  const defaults = {
    ws_url: '',
    company_name: 'Your Company',
    company_address: '',
    company_phone: '',
    company_email: '',
    bill_prefix: 'INV',
    bill_format: 'thermal_80mm', // thermal_80mm | a4
    next_bill_seq: '1',
    api_base_url: '',
    api_endpoint_bills: '',
    api_endpoint_logs: '',
    api_endpoint_transactions: '',
    api_health_endpoint: '/api/health',
    api_key: '',
    skip_ssl_verify: '0',
    security_password: hashPassword('admin'),
    auto_lock: '1',
    lock_on_startup: '1',
    theme: 'light',
    charging_rate_mode: 'percentage',
    default_battery_capacity_kwh: '',
    branding_logo: '',
    invoice_logo: '',
    show_logo_on_bill: '1',
    service_fee: '0',
    service_charge: '0',
    company_address: '',
    company_phone: '',
    company_email: '',
    company_footer: '',
    api_customer_search_endpoint: '',
    api_company_info_endpoint: '',
    api_bill_format_endpoint: '',
    api_bill_details_endpoint: '',
    api_bill_number_endpoint: '',
    api_login_endpoint: '',
    api_username: '',
    api_password: '',
    api_token: '',
    api_token_expires_at: '',
    printer_type: 'system',
    thermal_print_mode: 'raster',
    printer_network_ip: '',
    printer_network_port: '9100',
    printer_bt_com: '',
    bt_printer_address: '',
    bt_printer_name: '',
    paper_width: '80',
    bill_display_format: 'professional',
    recovery_grace_sec: RECOVERY_GRACE_SEC_DEFAULT
  };
  const insert = db.prepare(
    'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)'
  );
  const tx = db.transaction(() => {
    for (const [k, v] of Object.entries(defaults)) insert.run(k, v);
  });
  tx();
}

function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

function setSettings(obj) {
  const upsert = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  );
  const tx = db.transaction((entries) => {
    for (const [k, v] of entries) upsert.run(k, String(v));
  });
  tx(Object.entries(obj));
  return getSettings();
}

function resetAppData() {
  const tables = ['pending_commands', 'sync_queue', 'logs', 'bills', 'transactions', 'connectors', 'chargers', 'shifts', 'settings'];
  const tx = db.transaction(() => {
    for (const table of tables) db.prepare(`DELETE FROM ${table}`).run();
    seedDefaults();
  });
  tx();
  return getSettings();
}

function nextBillNumber() {
  const s = getSettings();
  const seq = parseInt(s.next_bill_seq || '1', 10);
  setSettings({ next_bill_seq: seq + 1 });
  const padded = String(seq).padStart(5, '0');
  return `${s.bill_prefix}-${padded}`;
}

module.exports = {
  init,
  get raw() {
    return db;
  },
  getSettings,
  setSettings,
  resetAppData,
  nextBillNumber
};
