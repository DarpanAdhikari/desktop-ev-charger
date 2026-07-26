const db = require('../db/db');
const { validateHttpUrl } = require('../utils');

const POLL_MS = 10000;
const MAX_ATTEMPTS = 8;
const BATCH_SIZE = 20;

let timer = null;

async function drainOnce() {
  const raw = db.raw;
  const settings = db.getSettings();
  if (!settings.api_base_url) return; // not configured yet — nothing to do
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
    if (!endpointPath) continue; // that entity type has no endpoint configured yet
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
      raw
        .prepare(
          `UPDATE sync_queue SET status='failed', attempts=attempts+1, last_error=?, updated_at=? WHERE id=?`
        )
        .run(String(err), new Date().toISOString(), row.id);
    }
  }
}

function markEntitySynced(entityType, entityId) {
  const raw = db.raw;
  const table = { bill: 'bills', transaction: 'transactions', log: 'logs' }[entityType];
  if (!table || table === 'logs') return; // logs table has no synced column
  raw.prepare(`UPDATE ${table} SET synced = 1 WHERE id = ?`).run(entityId);
}

function start() {
  if (timer) return;
  timer = setInterval(() => {
    drainOnce().catch(() => {});
  }, POLL_MS);
  drainOnce().catch(() => {});
}

function stop() {
  clearInterval(timer);
  timer = null;
}

module.exports = { start, stop, drainOnce };
