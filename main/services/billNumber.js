const apiAuth = require('./apiAuth');
let db = require('../db/db');

let cachedNumber = null;
let inflight = null;

function setDeps(custom) {
  if (custom && custom.db) db = custom.db;
  if (custom && custom.apiAuth) apiAuth = custom.apiAuth;
}

// Extract the next bill number from a GET response, whatever its shape.
function parseNextBillNumber(body) {
  let parsed = null;
  try { parsed = JSON.parse(body); } catch (e) { return null; }
  if (!parsed || typeof parsed !== 'object') return null;
  const root = parsed.data && typeof parsed.data === 'object' ? parsed.data : parsed;
  const number = root.bill_number ?? root.next_bill_number ?? root.number ?? root.nextNumber;
  return number != null ? String(number) : null;
}

function getEndpointUrl(settings) {
  if (!settings.api_base_url || !settings.api_bill_number_endpoint) return null;
  const url = settings.api_base_url.replace(/\/$/, '') + settings.api_bill_number_endpoint;
  const err = require('../utils').validateHttpUrl(url);
  return err ? null : url;
}

// Ask the server for the next bill number and cache it.
async function fetchNext() {
  const settings = db.getSettings();
  const url = getEndpointUrl(settings);
  if (!url) return null;
  try {
    const headers = await apiAuth.authHeaders();
    const res = await apiAuth._httpRequest(url, {
      method: 'GET',
      headers,
      rejectUnauthorized: settings.skip_ssl_verify !== '1'
    });
    if (res.statusCode < 200 || res.statusCode >= 300) return null;
    const number = parseNextBillNumber(res.body);
    if (number == null) return null;
    cachedNumber = number;
    return number;
  } catch (e) {
    return null;
  }
}

// Fire-and-forget refill so the next bill is never blocked on the network.
function ensure() {
  if (cachedNumber) return Promise.resolve(cachedNumber);
  if (inflight) return inflight;
  inflight = fetchNext().catch(() => null).finally(() => { inflight = null; });
  return inflight;
}

// Synchronous take for use inside bill creation. Returns the server number
// when one is cached, otherwise null (caller falls back to the local seq).
function consume() {
  const number = cachedNumber;
  if (number == null) return null;
  cachedNumber = null;
  ensure();
  return number;
}

module.exports = { setDeps, ensure, consume, parseNextBillNumber };
