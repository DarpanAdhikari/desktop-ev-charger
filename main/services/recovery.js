let db = require('../db/db');
let billing = require('./billing');
const { RECOVERY_GRACE_SEC_DEFAULT, ATTENTION_CHECK_MS, PENDING_DRAIN_LIMIT, METER_RECONCILE_TOLERANCE_KWH } = require('../constants');

let onEvent = () => {};
let getLiveData = () => null;

function setDeps(custom) {
  if (custom && custom.db) db = custom.db;
  if (custom && custom.billing) billing = custom.billing;
}

function setEventHandler(handler) {
  onEvent = typeof handler === 'function' ? handler : () => {};
}

function setMeterProvider(provider) {
  getLiveData = typeof provider === 'function' ? provider : () => null;
}

function getGraceMs() {
  const s = db.getSettings();
  const sec = parseInt(s.recovery_grace_sec || RECOVERY_GRACE_SEC_DEFAULT, 10);
  return (Number.isFinite(sec) ? sec : parseInt(RECOVERY_GRACE_SEC_DEFAULT, 10)) * 1000;
}

function nowIso() {
  return new Date().toISOString();
}

function queueTransactionSync(txId) {
  const raw = db.raw;
  const tx = raw.prepare('SELECT * FROM transactions WHERE id = ?').get(txId);
  if (!tx) return;
  raw
    .prepare(
      `INSERT INTO sync_queue (entity_type, entity_id, endpoint_key, payload, created_at)
       VALUES ('transaction', ?, 'api_endpoint_transactions', ?, ?)`
    )
    .run(txId, JSON.stringify(tx), nowIso());
}

function toFinite(value) {
  if (value == null || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function tryParse(text) {
  try { return JSON.parse(text); } catch (e) { return null; }
}

// Pull session data (energy/elapsed/soc/customer) out of any stored event.
function sessionDataFromLogPayload(payload, connectorId) {
  if (!payload || typeof payload !== 'object') return null;
  let session = payload.session || null;
  if (!session && payload.connectors && typeof payload.connectors === 'object') {
    const conn = payload.connectors[String(connectorId)];
    session = (conn && conn.transaction && conn.transaction.session) || null;
  }
  if (!session || typeof session !== 'object') return null;
  const data = {
    energy: toFinite(session.energy),
    elapsed: toFinite(session.elapsed_sec),
    socStart: toFinite(session.soc_start),
    socEnd: toFinite(session.soc_end)
  };
  // Cumulative meter anchors: transaction_started carries the counter at
  // session start (top-level energy), the stopped summary at session end.
  if (payload.energy != null) data.meterStart = toFinite(payload.energy);
  if (payload.summary && payload.summary.energy != null) data.meterEnd = toFinite(payload.summary.energy);
  const customer = {};
  for (const f of ['customer_id', 'customer_name', 'customer_pan', 'customer_address', 'customer_vehicle']) {
    const v = session[f] ?? payload[f];
    if (v != null) customer[f] = String(v);
  }
  if (Object.keys(customer).length > 0) data.customer = customer;
  return data;
}

// Most recent usable session data for a connector, recovered from the logs
// (meter/snapshot/started events) so a crash never loses the last readings.
function findLogSessionData(chargerId, connectorId, tx) {
  const raw = db.raw;
  const since = tx.started_at
    ? new Date(new Date(tx.started_at).getTime() - 3600000).toISOString()
    : null;
  const rows = raw
    .prepare(
      `SELECT ts, type, payload FROM logs
       WHERE charger_id = ? AND type IN ('meter', 'snapshot', 'transaction_started')
         AND json_extract(payload, '$.connector_id') = ?
         ${since ? 'AND ts >= ?' : ''}
       ORDER BY ts DESC, id DESC LIMIT 50`
    )
    .all(chargerId, connectorId, ...(since ? [since] : []));
  const wanted = tx.ocpp_tx_id != null ? String(tx.ocpp_tx_id) : null;
  for (const row of rows) {
    const payload = tryParse(row.payload);
    if (!payload) continue;
    if (wanted && payload.transaction_id != null && String(payload.transaction_id) !== wanted) continue;
    const data = sessionDataFromLogPayload(payload, connectorId);
    if (data && data.elapsed != null) return data;
  }
  // The very last event carries the best picture even without a session block.
  for (const row of rows) {
    const payload = tryParse(row.payload);
    const data = payload ? sessionDataFromLogPayload(payload, connectorId) : null;
    if (data) return data;
  }
  return null;
}

function lastKnownSession(chargerId, connectorId, tx) {
  const live = getLiveData(chargerId, connectorId);
  const session = (live && live.session) || {};
  // Fall back to the logs so a restart never finalizes from stale row values.
  const logData = findLogSessionData(chargerId, connectorId, tx);
  const elapsed = toFinite(session.elapsed_sec) ?? (logData && logData.elapsed) ?? toFinite(tx.duration_sec);
  return {
    energy: toFinite(session.energy) ?? (logData && logData.energy) ?? toFinite(tx.energy_kwh) ?? 0,
    socStart: toFinite(session.soc_start) ?? (logData && logData.socStart) ?? toFinite(tx.soc_start),
    socEnd: toFinite(session.soc_end) ?? (logData && logData.socEnd) ?? toFinite(tx.soc_end),
    elapsed,
    customer: (logData && logData.customer) || null,
    // Cumulative meter counter anchors: prefer the server's own values from
    // the logs (started event / stopped summary), else the stored row values.
    meterStart: (logData && logData.meterStart) ?? toFinite(tx.meter_energy_start_kwh),
    meterEnd: (logData && logData.meterEnd) ?? null,
    // The server sends no absolute end time; derive it from the real start
    // plus the session duration instead of stamping the finalize moment.
    stoppedAt: elapsed != null && tx.started_at
      ? new Date(new Date(tx.started_at).getTime() + elapsed * 1000).toISOString()
      : nowIso()
  };
}

function finalizeTransaction(tx, reason, opts = {}) {
  const raw = db.raw;
  const current = raw.prepare('SELECT status, billed FROM transactions WHERE id = ?').get(tx.id);
  if (!current || current.status !== 'active') return null;

  // opts.known lets recovery supply log-derived values instead of live data.
  const known = opts.known || lastKnownSession(tx.charger_id, tx.connector_id, tx);
  const stoppedAt = opts.stoppedAt || known.stoppedAt || (
    known.elapsed != null && tx.started_at
      ? new Date(new Date(tx.started_at).getTime() + known.elapsed * 1000).toISOString()
      : nowIso()
  );
  // Meter window: prefer the server's own counters (start from the
  // transaction_started payload, end from the stopped summary) when available;
  // otherwise keep the range self-consistent so end - start equals the billed
  // energy even if the final meter readings were missed.
  const knownStart = known.meterStart != null ? known.meterStart : toFinite(tx.meter_energy_start_kwh);
  const knownEnd = known.meterEnd != null ? known.meterEnd : null;
  let meterStart = knownStart;
  let meterEnd = knownEnd;
  if (meterEnd == null && meterStart != null && known.energy != null) {
    meterEnd = meterStart + known.energy;
  } else if (meterStart == null && meterEnd != null && known.energy != null) {
    meterStart = meterEnd - known.energy;
  }
  let flagged = opts.flagged ? 1 : 0;
  let flagReason = opts.flagged ? (opts.flagReason || reason) : null;
  if (meterStart != null && meterEnd != null && known.energy != null &&
      Math.abs(meterEnd - meterStart - known.energy) > METER_RECONCILE_TOLERANCE_KWH) {
    // The counters contradict the billed energy: surface the discrepancy for
    // operator verification instead of printing a bill from bad readings.
    flagged = 1;
    flagReason = 'meter_mismatch';
  }
  const customer = known.customer || {};

  raw
    .prepare(
      `UPDATE transactions SET stopped_at=?, duration_sec=?, energy_kwh=?, soc_start=?, soc_end=?,
         meter_energy_start_kwh=COALESCE(?, meter_energy_start_kwh),
         meter_energy_end_kwh=?,
         customer_id=COALESCE(?, customer_id),
         customer_name=COALESCE(?, customer_name),
         customer_pan=COALESCE(?, customer_pan),
         customer_address=COALESCE(?, customer_address),
         customer_vehicle=COALESCE(?, customer_vehicle),
         status='stopped', flagged=?, flag_reason=? WHERE id=?`
    )
    .run(
      stoppedAt,
      known.elapsed,
      known.energy,
      known.socStart,
      known.socEnd,
      meterStart,
      meterEnd,
      customer.customer_id != null ? customer.customer_id : null,
      customer.customer_name != null ? customer.customer_name : null,
      customer.customer_pan != null ? customer.customer_pan : null,
      customer.customer_address != null ? customer.customer_address : null,
      customer.customer_vehicle != null ? customer.customer_vehicle : null,
      flagged,
      flagReason,
      tx.id
    );

  const updated = raw.prepare('SELECT * FROM transactions WHERE id = ?').get(tx.id);

  let bill = null;
  try {
    bill = billing.generateBillForTransaction(tx.id);
    raw.prepare("UPDATE transactions SET billed = 1 WHERE id = ?").run(tx.id);
  } catch (e) {
    onEvent({ type: 'bill_error', error: String(e), tx_id: tx.id, charger_id: tx.charger_id });
  }
  queueTransactionSync(tx.id);

  const emitType = opts.emitType || null;
  if (emitType) {
    onEvent({
      type: emitType,
      tx: updated,
      bill,
      reason,
      charger_id: tx.charger_id,
      connector_id: tx.connector_id,
      ts: nowIso()
    });
  }
  return { tx: updated, bill, reason };
}

// After a snapshot: decide for each local active tx of that charger.
function reconcileFromSnapshot(evt) {
  const raw = db.raw;
  const chargerId = evt.charger_id;
  if (!chargerId) return;
  const now = nowIso();

  const serverTxByConn = new Map();
  for (const [connIdRaw, connector] of Object.entries(evt.connectors || {})) {
    const connId = Number(connIdRaw);
    if (!Number.isFinite(connId)) continue;
    const tx = connector.transaction || null;
    serverTxByConn.set(connId, tx ? toFinite(tx.transaction_id) : null);
  }

  const activeTxs = raw
    .prepare(
      `SELECT * FROM transactions WHERE charger_id = ? AND status = 'active' ORDER BY id ASC`
    )
    .all(chargerId);

  for (const tx of activeTxs) {
    const serverTxId = serverTxByConn.get(tx.connector_id);

    if (serverTxId == null) {
      // Connector present but has no running transaction on the server:
      // the session ended while we were offline -> finalize from last known data.
      finalizeTransaction(tx, 'server_session_closed', { emitType: 'session_recovered' });
      continue;
    }

    if (serverTxId !== tx.ocpp_tx_id) {
      // Server has a different transaction on this connector -> ours is over.
      finalizeTransaction(tx, 'server_session_closed', { emitType: 'session_recovered' });
      continue;
    }

    // Same transaction is still open on the server: it survived an outage
    // (or was resumed automatically). Flag for operator verification, never auto-stop.
    const flagged = raw
      .prepare('UPDATE transactions SET flagged = 1, flag_reason = ? WHERE id = ? AND flagged = 0')
      .run('resumed_after_outage', tx.id);
    if (flagged.changes > 0) {
      onEvent({
        type: 'session_attention',
        tx: { ...tx, flagged: 1, flag_reason: 'resumed_after_outage' },
        reason: 'resumed_after_outage',
        charger_id: chargerId,
        connector_id: tx.connector_id,
        ts: now
      });
    }
  }
}

// Periodic attention pass: flag active sessions whose charger/connector went silent.
function checkAttention() {
  const raw = db.raw;
  const graceMs = getGraceMs();
  const now = Date.now();
  const staleThreshold = new Date(now - graceMs).toISOString();

  const activeTxs = raw
    .prepare(`SELECT * FROM transactions WHERE status = 'active' AND flagged = 0`)
    .all();

  for (const tx of activeTxs) {
    const charger = raw
      .prepare('SELECT last_seen, online FROM chargers WHERE id = ?')
      .get(tx.charger_id);
    const connector = raw
      .prepare('SELECT status, updated_at FROM connectors WHERE charger_id = ? AND connector_id = ?')
      .get(tx.charger_id, tx.connector_id);

    const chargerDead = !charger || !charger.online || !charger.last_seen || charger.last_seen < staleThreshold;
    const connectorDead = !connector || !connector.updated_at || connector.updated_at < staleThreshold;
    if (!chargerDead && !connectorDead) continue;

    raw
      .prepare('UPDATE transactions SET flagged = 1, flag_reason = ? WHERE id = ?')
      .run('connector_offline', tx.id);
    onEvent({
      type: 'session_attention',
      tx: { ...tx, flagged: 1, flag_reason: 'connector_offline' },
      reason: 'connector_offline',
      charger_id: tx.charger_id,
      connector_id: tx.connector_id,
      ts: nowIso()
    });
  }
}

// Immediate flagging when the connector reports a fault mid-session.
function flagFaulted(chargerId, connectorId) {
  if (chargerId == null || connectorId == null) return;
  const raw = db.raw;
  const tx = raw
    .prepare(
      `SELECT * FROM transactions WHERE charger_id = ? AND connector_id = ? AND status = 'active'`
    )
    .get(chargerId, connectorId);
  if (!tx || tx.flagged) return;
  raw
    .prepare('UPDATE transactions SET flagged = 1, flag_reason = ? WHERE id = ?')
    .run('connector_fault', tx.id);
  onEvent({
    type: 'session_attention',
    tx: { ...tx, flagged: 1, flag_reason: 'connector_fault' },
    reason: 'connector_fault',
    charger_id: chargerId,
    connector_id: connectorId,
    ts: nowIso()
  });
}

// Operator decision: close the session using the most recent log/live data.
function forceCloseSession(txId) {
  const raw = db.raw;
  const tx = raw.prepare('SELECT * FROM transactions WHERE id = ?').get(txId);
  if (!tx) return { success: false, reason: 'transaction_not_found' };
  if (tx.status !== 'active') return { success: false, reason: 'not_active' };
  if (!tx.customer_id && !tx.customer_name) return { success: false, reason: 'no_customer' };

  const result = finalizeTransaction(tx, 'force_closed', { flagged: false, emitType: 'session_closed' });
  if (!result) return { success: false, reason: 'already_closed' };

  return { success: true, tx: result.tx, bill: result.bill };
}

// Retry billing for a stopped-but-unbilled transaction.
function retryBilling(txId) {
  const raw = db.raw;
  const tx = raw.prepare('SELECT * FROM transactions WHERE id = ?').get(txId);
  if (!tx) return { success: false, reason: 'transaction_not_found' };
  if (tx.status !== 'stopped') return { success: false, reason: 'not_stopped' };
  if (tx.billed) return { success: false, reason: 'already_billed' };
  try {
    const bill = billing.generateBillForTransaction(txId);
    raw.prepare('UPDATE transactions SET billed = 1 WHERE id = ?').run(txId);
    queueTransactionSync(txId);
    return { success: true, bill };
  } catch (e) {
    return { success: false, reason: String(e.message || e) };
  }
}

function listAttention() {
  const raw = db.raw;
  const rows = raw
    .prepare(
      `SELECT * FROM transactions
       WHERE (status = 'active' AND flagged = 1) OR (status = 'stopped' AND billed = 0)
       ORDER BY id DESC LIMIT ${PENDING_DRAIN_LIMIT}`
    )
    .all();
  return rows.map((tx) => {
    const bill = tx.billed
      ? null
      : raw.prepare('SELECT id, bill_number, total, created_at FROM bills WHERE transaction_id = ?').get(tx.id);
    return { ...tx, bill: bill || null };
  });
}

// Startup pass after a crash/force stop. For every session still marked active
// the app has no live data, so look up the logs: if the last event is a
// transaction_stopped the app crashed between logging and finalizing - close
// confidently from its summary. Otherwise, if the connector went silent
// beyond the grace period, the session is presumed over - close from the most
// recent reading in the logs (energy/elapsed/customer mapping), and flag the
// rest instead of fabricating a bill.
function recoverOnStartup() {
  const raw = db.raw;
  const graceMs = getGraceMs();
  const actives = raw.prepare("SELECT * FROM transactions WHERE status = 'active'").all();
  const lastLog = raw.prepare(
    `SELECT ts, type, payload FROM logs
     WHERE charger_id = ? AND json_extract(payload, '$.connector_id') = ?
     ORDER BY ts DESC, id DESC LIMIT 1`
  );
  for (const tx of actives) {
    const log = lastLog.get(tx.charger_id, tx.connector_id);
    if (!log) continue;

    if (log.type === 'transaction_stopped') {
      const payload = tryParse(log.payload);
      const summary = (payload && payload.summary) || {};
      const customer = {};
      for (const f of ['customer_id', 'customer_name', 'customer_pan', 'customer_address', 'customer_vehicle']) {
        const v = summary[f] ?? (payload ? payload[f] : null);
        if (v != null) customer[f] = String(v);
      }
      finalizeTransaction(tx, 'recovered_stopped_log', {
        stoppedAt: log.ts,
        known: {
          energy: toFinite(summary.energy_kwh) ?? toFinite(tx.energy_kwh) ?? 0,
          elapsed: toFinite(summary.duration_sec) ?? toFinite(tx.duration_sec),
          socStart: toFinite(summary.soc_start) ?? toFinite(tx.soc_start),
          socEnd: toFinite(summary.soc_end) ?? toFinite(tx.soc_end),
          customer,
          // The stopped summary carries the cumulative counter at stop.
          meterEnd: toFinite(summary.energy)
        },
        emitType: 'session_recovered'
      });
      continue;
    }

    if (Date.now() - Date.parse(log.ts) > graceMs) {
      const data = sessionDataFromLogPayload(tryParse(log.payload), tx.connector_id);
      if (data && data.elapsed != null) {
        finalizeTransaction(tx, 'recovered_offline_session', {
          known: data,
          emitType: 'session_recovered'
        });
      } else {
        raw
          .prepare('UPDATE transactions SET flagged = 1, flag_reason = ? WHERE id = ?')
          .run('recovery_no_data', tx.id);
      }
    }
    // Logs look recent: the session may still be live; the next snapshot
    // reconciles it server-authoritatively.
  }
}

let attentionTimer = null;

function start() {
  if (attentionTimer) return;
  attentionTimer = setInterval(() => {
    try { checkAttention(); } catch (e) { /* keep running */ }
  }, ATTENTION_CHECK_MS);
}

function stop() {
  clearInterval(attentionTimer);
  attentionTimer = null;
}

module.exports = {
  setDeps,
  setEventHandler,
  setMeterProvider,
  reconcileFromSnapshot,
  recoverOnStartup,
  checkAttention,
  flagFaulted,
  forceCloseSession,
  retryBilling,
  listAttention,
  queueTransactionSync,
  start,
  stop
};
