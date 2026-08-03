/**
 * Conformance check: exercises every endpoint exactly the way the desktop app
 * does and prints a PASS/FAIL table. Exits non-zero on any failure.
 *
 * Run (start the server first):
 *   node conformance-check.js
 *
 * Env:
 *   BASE_URL   server base URL   (default http://localhost:8080)
 *   USER       login username    (default admin)
 *   PASS       login password    (default admin123)
 */
const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');

const BASE_URL = (process.env.BASE_URL || 'http://localhost:8080').replace(/\/$/, '');
const USER = process.env.USER || 'admin';
const PASS = process.env.PASS || 'admin123';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  -- ' + detail}`);
}

// Minimal request helper using node:http/https (Connection: close) so there are
// no keep-alive sockets hanging around at process exit.
function rawRequest(url, opts) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, { method: opts.method || 'GET', headers: opts.headers || {} }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, text: data }));
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

async function request(path, { method = 'GET', headers = {}, body } = {}) {
  const r = await rawRequest(`${BASE_URL}${path}`, {
    method,
    headers: { 'Connection': 'close', ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = JSON.parse(r.text); } catch (e) { /* non-JSON */ }
  return { status: r.status, text: r.text, json };
}

const stamp = Date.now();
const SAMPLE_BILL = {
  id: 9001,
  bill_number: `INV-${stamp}`,
  transaction_id: 5001,
  company_name: 'DRP Demo Charging Co.',
  customer_id: 'CUST-0001',
  customer_name: 'Aarav Shrestha',
  customer_pan: 'PAN-1001',
  customer_vehicle: 'BA 1 JA 1234',
  energy_kwh: 12.345,
  rate_per_kwh: 15,
  subtotal: 185.18,
  tax_percent: 13,
  tax_amount: 24.07,
  service_fee: 0,
  service_charge: 0,
  total: 209.25,
  soc_start: 40,
  soc_end: 80,
  meter_energy_start_kwh: 75881.96,
  meter_energy_end_kwh: 75894.31,
  created_at: new Date().toISOString(),
};

async function main() {
  // 1. Health (public)
  {
    const r = await request('/api/health');
    check('GET /api/health', r.status === 200 && r.json.status === 'ok', `status=${r.status}`);
  }

  // 2. Login -> token
  let loginOk = false;
  const r = await request('/api/login', {
    method: 'POST',
    body: { username: USER, password: PASS },
  });
  loginOk = r.status === 200 && typeof r.json.access_token === 'string' && Number(r.json.expires_in) > 0;
  check('POST /api/login', loginOk, `status=${r.status}`);
  const token = loginOk ? r.json.access_token : '';
  const auth = { Authorization: `Bearer ${token}` };

  // 3. Bad credentials are rejected
  {
    const r = await request('/api/login', { method: 'POST', body: { username: 'x', password: 'y' } });
    check('POST /api/login rejects bad credentials', r.status === 401, `status=${r.status}`);
  }

  // 4. Auth gate
  {
    const r = await request('/api/company');
    check('protected route rejects missing token', r.status === 401, `status=${r.status}`);
  }

  // 5. Next bill number
  let nextNumber = '';
  {
    const r = await request('/api/bill/next-number', { headers: auth });
    const ok = r.status === 200 && typeof r.json.bill_number === 'string' && r.json.bill_number.length > 0;
    check('GET /api/bill/next-number', ok, `status=${r.status}`);
    if (ok) nextNumber = r.json.bill_number;
  }

  // 6. Bills ingestion returns a server id
  let serverBillId = null;
  let billsStatus = 0;
  {
    const r = await request('/api/bills', { method: 'POST', headers: auth, body: SAMPLE_BILL });
    billsStatus = r.status;
    serverBillId = r.json && r.json.id != null ? r.json.id : null;
    check('POST /api/bills (id returned)', r.status >= 200 && r.status < 300 && serverBillId != null, `status=${r.status} id=${serverBillId}`);
  }

  // 7. Bill details round-trips the stored bill
  {
    const r = await request(`/api/bill/details?bill_number=${encodeURIComponent(SAMPLE_BILL.bill_number)}`, { headers: auth });
    check(
      'GET /api/bill/details round-trip',
      r.status === 200 && r.json.bill_number === SAMPLE_BILL.bill_number && Number(r.json.total) === SAMPLE_BILL.total,
      `status=${r.status}`
    );
  }

  // 8. Company info, incl. invoice prefix
  {
    const r = await request('/api/company', { headers: auth });
    check('GET /api/company (invoice_prefix)', r.status === 200 && !!r.json.company_name && !!r.json.invoice_prefix, `status=${r.status}`);
  }

  // 9. Customer search
  {
    const r = await request('/api/customers/search?q=binita', { headers: auth });
    check(
      'GET /api/customers/search?q=',
      r.status === 200 && Array.isArray(r.json) && r.json.length > 0,
      `status=${r.status} count=${Array.isArray(r.json) ? r.json.length : '-'}`
    );
  }

  // 10. Bill template (custom format HTML)
  {
    const r = await request('/api/bill/template', { headers: auth });
    check('GET /api/bill/template', r.status === 200 && r.text.includes('{{bill_number}}'), `status=${r.status}`);
  }

  // 11. Transactions ingestion
  {
    const r = await request('/api/transactions', {
      method: 'POST', headers: auth,
      body: { id: 5001, charger_id: 'REF-1', connector_id: 1, ocpp_tx_id: 901, started_at: new Date().toISOString(), status: 'stopped', energy_kwh: 12.3 },
    });
    check('POST /api/transactions', r.status >= 200 && r.status < 300 && r.json.received === true, `status=${r.status}`);
  }

  // 12. Logs ingestion
  {
    const r = await request('/api/logs', {
      method: 'POST', headers: auth,
      body: { id: 7001, ts: new Date().toISOString(), charger_id: 'REF-1', type: 'meter', payload: JSON.stringify({ type: 'meter' }) },
    });
    check('POST /api/logs', r.status >= 200 && r.status < 300 && r.json.received === true, `status=${r.status}`);
  }

  // 13. Bills re-delivery is idempotent (worker retry scenario)
  {
    const r = await request('/api/bills', { method: 'POST', headers: auth, body: SAMPLE_BILL });
    const duplicate = r.status === 200 && r.json.duplicate === true && r.json.id === serverBillId;
    check('POST /api/bills idempotent retry', duplicate, `status=${r.status} id=${r.json ? r.json.id : '-'}`);
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed.`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});