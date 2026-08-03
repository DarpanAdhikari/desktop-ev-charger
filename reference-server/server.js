/**
 * VoltDesk / DRP reference backend.
 *
 * A small, dependency-light HTTP server that implements the exact REST contract
 * the desktop app expects. Use it as the starter for your own backend, or run
 * it as-is to connect the app end-to-end.
 *
 * Run:
 *   node server.js
 *
 * Env config:
 *   PORT             port to listen on            (default 8080)
 *   HOST             bind interface               (default 0.0.0.0)
 *   ADMIN_USER       login username               (default "admin")
 *   ADMIN_PASS       login password               (default "admin123")
 *   AUTH_DISABLED    "1" to turn off auth checks  (default "0")
 *   TOKEN_TTL        token lifetime in seconds    (default 86400)
 *   DB_PATH          data file location           (default ./data/data.db)
 *
 * The app calls api_base_url + <endpoint path> for each setting listed in
 * Settings -> Backend Sync. See ../docs/backend-api.md for the full contract.
 */
const http = require('http');
const { URL } = require('node:url');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT || '8080', 10);
const HOST = process.env.HOST || '0.0.0.0';
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';
const AUTH_DISABLED = process.env.AUTH_DISABLED === '1';
const TOKEN_TTL = parseInt(process.env.TOKEN_TTL || '86400', 10);
const DB_PATH = path.isAbsolute(process.env.DB_PATH || '')
  ? process.env.DB_PATH
  : path.join(__dirname, process.env.DB_PATH || path.join('data', 'data.db'));
const TEMPLATE_FILE = path.join(__dirname, 'bill-template.html');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

// Prefer the built-in node:sqlite (Node >= 22.5, zero install). Fall back to
// better-sqlite3 for older runtimes (it must match THIS node's ABI).
let db;
try {
  const { DatabaseSync } = require('node:sqlite');
  db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL');
} catch (e) {
  let Better;
  try {
    Better = require('better-sqlite3');
  } catch (e2) {
    console.error(
      'Need SQLite. Use Node >= 22.5 for the built-in node:sqlite, or run\n' +
      '`npm install better-sqlite3` in this folder so it can be rebuilt for this node.'
    );
    process.exit(1);
  }
  db = new Better(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL');
}

// ---------------------------------------------------------------------------
// Schema + seeds
// ---------------------------------------------------------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS company (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    company_name TEXT, company_address TEXT, company_phone TEXT, company_email TEXT,
    branding_logo TEXT, invoice_logo TEXT, invoice_prefix TEXT
  );
  INSERT OR IGNORE INTO company (id, company_name, company_address, company_phone, company_email, invoice_prefix)
    VALUES (1, 'DRP Demo Charging Co.', 'Demo St. 123, Kathmandu', '+977-1-0000000', 'billing@demo.example', 'INV');

  CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id TEXT UNIQUE, customer_name TEXT, customer_pan TEXT,
    customer_address TEXT, customer_vehicle TEXT
  );

  CREATE TABLE IF NOT EXISTS invoices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bill_number TEXT UNIQUE,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    app_transaction_id INTEGER,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS event_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    app_log_id INTEGER,
    ts TEXT, charger_id TEXT, type TEXT, payload TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tokens (
    token TEXT PRIMARY KEY,
    expires_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS counters (
    name TEXT PRIMARY KEY,
    value INTEGER NOT NULL DEFAULT 0
  );
  INSERT OR IGNORE INTO counters (name, value) VALUES ('bill_serial', 0);
`);

const seedCustomer = db.prepare(
  'INSERT OR IGNORE INTO customers (customer_id, customer_name, customer_pan, customer_address, customer_vehicle) VALUES (?, ?, ?, ?, ?)'
);
for (const c of [
  ['CUST-0001', 'Aarav Shrestha', 'PAN-1001', 'Lalitpur', 'BA 1 JA 1234'],
  ['CUST-0002', 'Binita Gurung', 'PAN-1002', 'Pokhara', 'GA 2 KHA 4567'],
  ['CUST-0003', 'Chetan Rai', 'PAN-1003', 'Chitwan', 'DA 1 PA 7890'],
]) {
  seedCustomer.run(...c);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function notFound(res, detail) {
  json(res, 404, { error: 'not_found', detail: detail || null });
}

function readBody(req, after) {
  let data = '';
  let tooBig = false;
  req.on('data', (chunk) => {
    if (tooBig) return;
    if (Buffer.byteLength(data) > 8 * 1024 * 1024) { tooBig = true; return; }
    data += chunk;
  });
  req.on('end', () => {
    if (tooBig) return after({ statusCode: 413 });
    if (!data) return after({ statusCode: null, body: null });
    let parsed = null;
    try {
      parsed = JSON.parse(data);
    } catch (e) {
      return after({ status: 400 });
    }
    if (!parsed || typeof parsed !== 'object') return after({ status: 400 });
    after({ status: null, body: parsed });
  });
}

function nowIso() {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
function issueToken() {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + TOKEN_TTL * 1000).toISOString();
  db.prepare('INSERT INTO tokens (token, expires_at) VALUES (?, ?)').run(token, expiresAt);
  return { token, expiresAt };
}

function authorize(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return false;
  const row = db.prepare('SELECT expires_at FROM tokens WHERE token = ?').get(token);
  if (!row) return false;
  return Date.parse(row.expires_at) > Date.now();
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------
function handleLogin(res, body) {
  const ok =
    body &&
    String(body.username || '') === ADMIN_USER &&
    String(body.password || '') === ADMIN_PASS;
  if (!ok) return json(res, 401, { error: 'invalid_credentials' });
  const { token, expiresAt } = issueToken();
  json(res, 200, {
    access_token: token,
    token_type: 'Bearer',
    expires_in: TOKEN_TTL,
    expires_at: expiresAt,
  });
}

function handleHealth(res) {
  json(res, 200, {
    status: 'ok',
    service: 'drp-reference-backend',
    version: '1.0.0',
    time: nowIso(),
    auth_enabled: !AUTH_DISABLED,
  });
}

function handleCompany(res) {
  const row = db.prepare('SELECT * FROM company WHERE id = 1').get();
  // App accepts invoice_prefix OR bill_prefix OR prefix for the invoice prefix.
  json(res, 200, { ...row, invoice_prefix: row.invoice_prefix || 'INV' });
}

function handleCustomerSearch(res, url) {
  const q = String(url.searchParams.get('q') || '').toLowerCase();
  const rows = db.prepare('SELECT * FROM customers ORDER BY id').all();
  if (!q) return json(res, 200, rows);
  const filtered = rows.filter((c) =>
    [c.customer_id, c.customer_name, c.customer_pan, c.customer_vehicle]
      .some((v) => v && String(v).toLowerCase().includes(q))
  );
  json(res, 200, filtered);
}

function handleBills(res, body) {
  if (!body || typeof body !== 'object') return json(res, 400, { error: 'bad_json' });
  const billNumber = body.bill_number || null;
  if (billNumber) {
    const existing = db
      .prepare('SELECT id, bill_number FROM invoices WHERE bill_number = ?')
      .get(billNumber);
    if (existing) {
      // Idempotent re-delivery: the worker may retry a 2xx it never observed.
      return json(res, 200, { id: existing.id, bill_number: existing.bill_number, duplicate: true });
    }
  }
  const info = db
    .prepare('INSERT INTO invoices (bill_number, payload, created_at) VALUES (?, ?, ?)')
    .run(billNumber, JSON.stringify(body), nowIso());
  // The app stores this id in bills.server_bill_id.
  json(res, 201, { id: info.lastInsertRowid, bill_number: billNumber, message: 'bill stored' });
}

function handleTransactions(res, body) {
  if (!body || typeof body !== 'object') return json(res, 400, { error: 'bad_json' });
  const info = db
    .prepare('INSERT INTO sessions (app_transaction_id, payload, created_at) VALUES (?, ?, ?)')
    .run(body.id != null ? body.id : null, JSON.stringify(body), nowIso());
  json(res, 201, { received: true, id: info.lastInsertRowid, app_transaction_id: body.id ?? null });
}

function handleLogs(res, body) {
  if (!body || typeof body !== 'object') return json(res, 400, { error: 'bad_json' });
  const info = db
    .prepare(
      'INSERT INTO event_logs (app_log_id, ts, charger_id, type, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(body.id != null ? body.id : null, body.ts || null, body.charger_id || null, body.type || null, JSON.stringify(body), nowIso());
  json(res, 201, { received: true, id: info.lastInsertRowid, app_log_id: body.id ?? null });
}

function handleNextBillNumber(res) {
  const prefix = db.prepare('SELECT invoice_prefix FROM company WHERE id = 1').get().invoice_prefix || 'INV';
  db.prepare("UPDATE counters SET value = value + 1 WHERE name = 'bill_serial'").run();
  const serial = db.prepare("SELECT value FROM counters WHERE name = 'bill_serial'").get().value;
  json(res, 200, { bill_number: `${prefix}-${String(serial).padStart(5, '0')}`, prefix, serial });
}

function handleBillDetails(res, url) {
  const billNumber = url.searchParams.get('bill_number') || null;
  if (!billNumber) return json(res, 400, { error: 'bill_number_required' });
  const row = db
    .prepare('SELECT payload FROM invoices WHERE bill_number = ? ORDER BY id DESC LIMIT 1')
    .get(billNumber);
  if (!row) return notFound(res, `bill ${billNumber} not found`);
  // Returns the stored bill payload; the app merges it over the local bill.
  json(res, 200, JSON.parse(row.payload));
}

function handleBillTemplate(res) {
  if (!fs.existsSync(TEMPLATE_FILE)) return notFound(res, 'bill-template.html not found next to server.js');
  const html = fs.readFileSync(TEMPLATE_FILE, 'utf8');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
const routes = [
  ['POST', '/api/login', handleLogin, true],
  ['GET', '/api/health', handleHealth, true],
  ['GET', '/api/company', handleCompany],
  ['GET', '/api/customers/search', handleCustomerSearch],
  ['GET', '/api/bill/template', handleBillTemplate],
  ['GET', '/api/bill/details', handleBillDetails],
  ['GET', '/api/bill/next-number', handleNextBillNumber],
  ['POST', '/api/bills', handleBills],
  ['POST', '/api/transactions', handleTransactions],
  ['POST', '/api/logs', handleLogs],
];

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const route = routes.find(([method, path, ,]) => method === req.method && path === url.pathname);
  if (!route) return json(res, 404, { error: 'not_found', method: req.method, path: url.pathname });

  const [, , handler, isPublic] = route;
  if (!isPublic && !AUTH_DISABLED && !authorize(req)) {
    return json(res, 401, { error: 'unauthorized', message: 'Missing or expired Bearer token. Login first.' });
  }

  if (req.method === 'GET') return handler(res, url);
  readBody(req, ({ status, body }) => {
    if (status) return json(res, status, { error: 'bad_request' });
    handler(res, body, url);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`DRP reference backend listening on http://${HOST}:${PORT}`);
  console.log(`  db:      ${DB_PATH}`);
  console.log(`  auth:    ${AUTH_DISABLED ? 'DISABLED (AUTH_DISABLED=1)' : `enabled (${ADMIN_USER} / ${ADMIN_PASS}, token TTL ${TOKEN_TTL}s)`}`);
  console.log(`  routes:  GET /api/health /api/login /api/company /api/customers/search`);
  console.log(`           GET /api/bill/template /api/bill/details /api/bill/next-number`);
  console.log(`           POST /api/bills /api/transactions /api/logs`);
});