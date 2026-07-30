const db = require('../db/db');
const { validateHttpUrl } = require('../utils');

const DEFAULT_POLL_MS = 10000;
const MAX_ATTEMPTS = 8;
const BATCH_SIZE = 20;

let timer = null;
let pollMs = DEFAULT_POLL_MS;

async function drainOnce() {
  const raw = db.raw;
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
    .all(MAX_ATTEMPTS, BATCH_SIZE);

  for (const row of rows) {
    const endpointPath = settings[row.endpoint_key];
    if (!endpointPath) continue;
    const url = settings.api_base_url.replace(/\/$/, '') + endpointPath;

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(settings.api_key ? { Authorization: `Bearer ${settings.api_key}` } : {})
        },
        body: row.payload
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      raw
        .prepare(
          `UPDATE sync_queue SET status='sent', attempts=attempts+1, updated_at=? WHERE id=?`
        )
        .run(new Date().toISOString(), row.id);

      markEntitySynced(row.entity_type, row.entity_id);
    } catch (err) {
      const attempts = row.attempts + 1;
      raw
        .prepare(
          `UPDATE sync_queue SET status=?, attempts=?, last_error=?, updated_at=? WHERE id=?`
        )
        .run(attempts >= MAX_ATTEMPTS ? 'failed' : 'pending', attempts, String(err), new Date().toISOString(), row.id);
    }
  }
}

function markEntitySynced(entityType, entityId) {
  const raw = db.raw;
  const table = { bill: 'bills', transaction: 'transactions', log: 'logs' }[entityType];
  if (!table || table === 'logs') return;
  raw.prepare(`UPDATE ${table} SET synced = 1 WHERE id = ?`).run(entityId);
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
  else pollMs = DEFAULT_POLL_MS;
  timer = setInterval(() => {
    drainOnce().catch(() => {});
  }, pollMs);
  drainOnce().catch(() => {});
}

function stop() {
  clearInterval(timer);
  timer = null;
}

module.exports = { start, stop, drainOnce, getStatus };
