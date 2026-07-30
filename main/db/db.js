const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { app } = require('electron');

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
  return db;
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
  ];
  for (const sql of migrations) {
    try { db.exec(sql); } catch (e) { /* column may already exist */ }
  }
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
    printer_type: 'system',
    thermal_print_mode: 'raster',
    printer_network_ip: '',
    printer_network_port: '9100',
    printer_bt_com: '',
    bt_printer_address: '',
    bt_printer_name: '',
    paper_width: ''
  };
  const insert = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(missingKeys)) {
    try { insert.run(k, v); } catch (e) { /* ignore */ }
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
    pin_code: '',
    theme: 'dark',
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
    printer_type: 'system',
    thermal_print_mode: 'raster',
    printer_network_ip: '',
    printer_network_port: '9100',
    printer_bt_com: '',
    bt_printer_address: '',
    bt_printer_name: '',
    paper_width: '80',
    bill_display_format: 'professional'
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
  const tables = ['sync_queue', 'logs', 'bills', 'transactions', 'connectors', 'chargers', 'shifts', 'settings'];
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
