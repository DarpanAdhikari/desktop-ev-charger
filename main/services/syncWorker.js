const http = require('http');
const https = require('https');
let db = require('../db/db');
const apiAuth = require('./apiAuth');
const { validateHttpUrl } = require('../utils');
const { SYNC_POLL_MS, SYNC_MAX_ATTEMPTS, SYNC_BATCH_SIZE, SYNC_SENT_RETENTION_DAYS, SYNC_LOG_RETENTION_DAYS } = require('../constants');

let timer = null;
let pollMs = SYNC_POLL_MS;
let sender = null;
let apiAuthSet = apiAuth;

function setDeps(custom) {
  if (custom && custom.db) db = custom.db;
  if (custom && custom.sender) sender = custom.sender;
  if (custom && custom.apiAuth) apiAuthSet = custom.apiAuth;
}

// Extract the server-assigned bill id from a response body, whatever its shape.
function parseServerBillId(body) {
  let parsed = null;
  try { parsed = JSON.parse(body); } catch (e) { return null; }
  if (!parsed || typeof parsed !== 'object') return null;
  const root = parsed.data && typeof parsed.data === 'object' ? parsed.data : parsed;
  const id = root.id ?? root.bill_id ?? root.server_bill_id;
  return id != null ? String(id) : null;
}

function httpRequest(url, { method, headers, body, rejectUnauthorized }) {
  return new Promise((resolve, reject) => {
    const isHttps = String(url).startsWith('https:');
    const mod = isHttps ? https : http;
    const options = { method, headers };
    if (isHttps) options.rejectUnauthorized = rejectUnauthorized !== false;
    const req = mod.request(url, options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function drainOnce() {
  const raw = db.raw;
  pruneQueue(raw);
  const settings = db.getSettings();
  if (!settings.api_base_url) return;
  const urlErr = validateHttpUrl(settings.api_base_url);
  if (urlErr) {
    console.error('[sync]', urlErr.message);
    return;
  }

  const rows = raw
    .prepare(
      `SELECT * FROM sync_queue WHERE status IN ('pending','failed') AND attempts < ?
       ORDER BY id ASC LIMIT ?`
    )
    .all(SYNC_MAX_ATTEMPTS, SYNC_BATCH_SIZE);

  const send = sender || ((url, opts) => httpRequest(url, opts));

  for (const row of rows) {
    const endpointPath = settings[row.endpoint_key];
    if (!endpointPath) continue;
    const url = settings.api_base_url.replace(/\/$/, '') + endpointPath;

    try {
      const headers = await apiAuthSet.authHeaders({ 'Content-Type': 'application/json' });
      let res = await send(url, {
        method: 'POST',
        headers,
        body: row.payload,
        rejectUnauthorized: settings.skip_ssl_verify !== '1'
      });
      // The token may have expired server-side: re-login once and retry.
      if (res.statusCode === 401 && headers.Authorization && !headers.Authorization.includes(settings.api_key || '__none__')) {
        apiAuthSet.clearToken();
        const retryHeaders = await apiAuthSet.authHeaders({ 'Content-Type': 'application/json' });
        if (retryHeaders.Authorization && retryHeaders.Authorization !== headers.Authorization) {
          res = await send(url, {
            method: 'POST',
            headers: retryHeaders,
            body: row.payload,
            rejectUnauthorized: settings.skip_ssl_verify !== '1'
          });
        }
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        throw new Error(`HTTP ${res.statusCode}`);
      }

      raw
        .prepare(
          `UPDATE sync_queue SET status='sent', attempts=attempts+1, updated_at=? WHERE id=?`
        )
        .run(new Date().toISOString(), row.id);

      markEntitySynced(row.entity_type, row.entity_id, res.body);
    } catch (err) {
      const attempts = row.attempts + 1;
      raw
        .prepare(
          `UPDATE sync_queue SET status=?, attempts=?, last_error=?, updated_at=? WHERE id=?`
        )
        .run(attempts >= SYNC_MAX_ATTEMPTS ? 'failed' : 'pending', attempts, String(err), new Date().toISOString(), row.id);
    }
  }
}

function markEntitySynced(entityType, entityId, responseBody) {
  const raw = db.raw;
  const table = { bill: 'bills', transaction: 'transactions', log: 'logs' }[entityType];
  if (!table || table === 'logs') return;
  raw.prepare(`UPDATE ${table} SET synced = 1 WHERE id = ?`).run(entityId);
  // Capture the id the backend assigned to this bill, if it returned one.
  if (entityType === 'bill' && responseBody) {
    const serverBillId = parseServerBillId(responseBody);
    if (serverBillId != null) {
      raw.prepare(`UPDATE ${table} SET server_bill_id = ? WHERE id = ?`).run(serverBillId, entityId);
    }
  }
}

// Keep the outbox bounded: drop old sent rows and stale unsent log rows.
// Bills and transactions are never pruned — only 'log' payloads are.
function pruneQueue(raw) {
  const sentCutoff = new Date(Date.now() - SYNC_SENT_RETENTION_DAYS * 86400000).toISOString();
  raw.prepare("DELETE FROM sync_queue WHERE status = 'sent' AND created_at < ?").run(sentCutoff);
  const logCutoff = new Date(Date.now() - SYNC_LOG_RETENTION_DAYS * 86400000).toISOString();
  raw.prepare("DELETE FROM sync_queue WHERE entity_type = 'log' AND status IN ('pending','failed') AND created_at < ?").run(logCutoff);
}

function getStatus() {
  const raw = db.raw;
  const pending = raw.prepare("SELECT COUNT(*) as c FROM sync_queue WHERE status='pending'").get();
  const failed = raw.prepare("SELECT COUNT(*) as c FROM sync_queue WHERE status='failed'").get();
  const sent = raw.prepare("SELECT COUNT(*) as c FROM sync_queue WHERE status='sent'").get();
  return {
    pending: pending ? pending.c : 0,
    failed: failed ? failed.c : 0,
    sent: sent ? sent.c : 0,
    pollIntervalMs: pollMs,
  };
}

function start(intervalMs) {
  if (timer) return;
  if (intervalMs && intervalMs >= 1000) pollMs = intervalMs;
  else pollMs = SYNC_POLL_MS;
  timer = setInterval(() => {
    drainOnce().catch(() => {});
  }, pollMs);
  drainOnce().catch(() => {});
}

function stop() {
  clearInterval(timer);
  timer = null;
}

module.exports = { start, stop, drainOnce, getStatus, setDeps };
