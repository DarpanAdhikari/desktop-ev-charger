const WebSocket = require('ws');
const db = require('../db/db');
const { generateBillForTransaction, findShiftForTime } = require('./billing');

const RECONNECT_DELAY_MS = 3000;

class CsmsClient {
  constructor(onEvent, options = {}) {
    this.onEvent = onEvent; // (channelEvent) => forwarded to renderer via IPC
    this.ws = null;
    this.url = null;
    this.reconnectTimer = null;
    this.manualClose = false;
    this._meterCache = new Map(); // key: "chargerId:connectorId" -> last meter/rate snapshot
    this.configure(options);
  }

  configure(options = {}) {
    this.chargingRateMode = options.chargingRateMode === 'kw' ? 'kw' : 'percentage';
    const capacity = Number(options.defaultBatteryCapacityKwh);
    this.defaultBatteryCapacityKwh = Number.isFinite(capacity) && capacity > 0 ? capacity : null;
    this.pendingCustomers = options.pendingCustomers || null;
  }

  connect(url, options = {}) {
    this.manualClose = false;
    this.url = url;
    this.skipSslVerify = options.skipSslVerify === true;
    this._open();
  }

  _open() {
    clearTimeout(this.reconnectTimer);
    const wsOptions = this.url.startsWith('wss://')
      ? { rejectUnauthorized: !this.skipSslVerify }
      : {};
    this.ws = new WebSocket(this.url, wsOptions);

    this.ws.on('open', () => {
      this.onEvent({ type: 'connection_status', status: 'connected', url: this.url });
    });

    this.ws.on('message', (raw) => {
      let data;
      try {
        data = JSON.parse(raw.toString());
      } catch {
        return;
      }
      this._handle(data);
    });

    this.ws.on('close', () => {
      this.onEvent({ type: 'connection_status', status: 'disconnected', url: this.url });
      if (!this.manualClose) {
        this.reconnectTimer = setTimeout(() => this._open(), RECONNECT_DELAY_MS);
      }
    });

    this.ws.on('error', () => {
      // 'close' fires right after; reconnection is handled there.
    });
  }

  disconnect() {
    this.manualClose = true;
    clearTimeout(this.reconnectTimer);
    if (this.ws) this.ws.close();
  }

  getMeterData(chargerId, connectorId) {
    if (!chargerId || connectorId == null) return null;
    return this._meterCache.get(`${chargerId}:${connectorId}`) || null;
  }

  clearLiveState() {
    this._meterCache.clear();
  }

  send(actionPayload) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(actionPayload));
    }
  }

  // ---- Persist + relay every event pushed by the CSMS ----
  _handle(evt) {
    const raw = db.raw;
    const now = new Date().toISOString();
    const chargerId = evt.charger_id;

    // Meter values are high-frequency live state. Keep them out of local storage
    // until the server includes both SoC endpoints needed for a useful session record.
    const shouldPersistEvent = evt.type !== 'meter' || hasSessionSocBounds(evt.session);
    if (chargerId && shouldPersistEvent) {
      const info = raw
        .prepare(
          `INSERT INTO logs (ts, charger_id, type, payload) VALUES (?, ?, ?, ?)`
        )
        .run(now, chargerId, evt.type, JSON.stringify(evt));
      raw
        .prepare(
          `INSERT INTO sync_queue (entity_type, entity_id, endpoint_key, payload, created_at)
           VALUES ('log', ?, 'api_endpoint_logs', ?, ?)`
        )
        .run(info.lastInsertRowid, JSON.stringify(evt), now);
    }

    switch (evt.type) {
      case 'boot':
        raw
          .prepare(
            `INSERT INTO chargers (id, vendor, model, first_seen, last_seen, online)
             VALUES (?, ?, ?, ?, ?, 1)
             ON CONFLICT(id) DO UPDATE SET vendor=excluded.vendor, model=excluded.model,
               last_seen=excluded.last_seen, online=1`
          )
          .run(chargerId, evt.vendor, evt.model, now, now);
        break;

      case 'snapshot':
        this._handleSnapshot(evt, now);
        break;

      case 'heartbeat':
        raw
          .prepare('UPDATE chargers SET last_seen = ?, online = 1 WHERE id = ?')
          .run(now, chargerId);
        break;

      case 'status_transition':
        raw
          .prepare(
            `INSERT INTO connectors (charger_id, connector_id, status, error_code, updated_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(charger_id, connector_id) DO UPDATE SET
               status=excluded.status, error_code=excluded.error_code, updated_at=excluded.updated_at`
          )
          .run(chargerId, evt.connector_id, evt.to, evt.error, now);
        break;

      case 'transaction_started': {
        let customerId = null, customerName = null, customerPan = null, customerAddress = null, customerVehicle = null;
        if (this.pendingCustomers && chargerId != null && evt.connector_id != null) {
          const key = `${chargerId}:${evt.connector_id}`;
          const cust = this.pendingCustomers.get(key);
          if (cust) {
            customerId = cust.customer_id || null;
            customerName = cust.customer_name || null;
            customerPan = cust.customer_pan || null;
            customerAddress = cust.customer_address || null;
            customerVehicle = cust.customer_vehicle || null;
            this.pendingCustomers.delete(key);
          }
        }
        raw
          .prepare(
            `INSERT INTO transactions (charger_id, connector_id, ocpp_tx_id, started_at, status,
              customer_id, customer_name, customer_pan, customer_address, customer_vehicle)
             VALUES (?, ?, ?, ?, 'active',
              ?, ?, ?, ?, ?)`
          )
          .run(chargerId, evt.connector_id, evt.transaction_id, now,
            customerId, customerName, customerPan, customerAddress, customerVehicle);
        break;
      }

      case 'meter': {
        const meter = evt.meter || {};
        const session = evt.session || {};
        const meterSoc = toFiniteNumber(
          meter.soc != null ? meter.soc : evt.soc != null ? evt.soc : evt.meter_soc
        );
        const powerKw = toFiniteNumber(meter.power);
        if (chargerId && evt.connector_id != null) {
          raw
            .prepare(
              `INSERT INTO chargers (id, first_seen, last_seen, online)
               VALUES (?, ?, ?, 1)
               ON CONFLICT(id) DO UPDATE SET last_seen=excluded.last_seen, online=1`
            )
            .run(chargerId, now, now);
          raw
            .prepare(
              `INSERT INTO connectors (charger_id, connector_id, status, error_code, updated_at)
               VALUES (?, ?, 'Unknown', NULL, ?)
               ON CONFLICT(charger_id, connector_id) DO UPDATE SET updated_at=excluded.updated_at`
            )
            .run(chargerId, evt.connector_id, now);

          const key = `${chargerId}:${evt.connector_id}`;
          const prev = this._meterCache.get(key);
          const meterTs = meter.timestamp ? new Date(meter.timestamp).getTime() : Date.now();
          let ratePerMin = prev ? prev.ratePerMin : 0;
          if (meterSoc != null && prev && prev.lastSoc != null && meterSoc !== prev.lastSoc) {
            const elapsedMs = meterTs - prev.lastTs;
            if (elapsedMs > 0) {
              ratePerMin = ((meterSoc - prev.lastSoc) / elapsedMs) * 60000;
            }
          }
          const rateKw = powerKw != null && powerKw > 0 ? powerKw : prev ? prev.rateKw : null;
          const estimatedCapacity = estimateBatteryCapacityKwh(session) || this.defaultBatteryCapacityKwh;
          const etaMinutes = this.chargingRateMode === 'kw'
            ? estimateEtaFromKw({ soc: meterSoc, powerKw: rateKw, capacityKwh: estimatedCapacity })
            : estimateEtaFromPercent({ soc: meterSoc, ratePerMin });
          const sessionEnergy = toFiniteNumber(session.energy);
          const sessionElapsed = toFiniteNumber(session.elapsed_sec);
          const sessionSocStart = toFiniteNumber(session.soc_start);
          const sessionSocEnd = toFiniteNumber(session.soc_end);
          const livePricing = calculateLivePricing(sessionEnergy);
          if (sessionSocStart != null && sessionSocEnd != null) {
            raw
              .prepare(
                `UPDATE transactions SET
                   energy_kwh=COALESCE(?, energy_kwh),
                   soc_start=COALESCE(soc_start, ?),
                   soc_end=COALESCE(?, soc_end),
                   duration_sec=COALESCE(?, duration_sec)
                 WHERE id = (
                   SELECT id FROM transactions
                   WHERE charger_id = ? AND connector_id = ? AND status = 'active'
                   ORDER BY id DESC LIMIT 1
                 )`
              )
              .run(
                sessionEnergy,
                sessionSocStart,
                sessionSocEnd,
                sessionElapsed,
                chargerId,
                evt.connector_id
              );
          }
          const snapshot = {
            lastTs: meterTs,
            lastSoc: meterSoc,
            meter,
            delta: evt.delta || null,
            session,
            ratePerMin,
            rate_per_min: ratePerMin > 0 ? Math.round(ratePerMin * 100) / 100 : 0,
            rateKw,
            rate_kw: rateKw != null ? Math.round(rateKw * 100) / 100 : null,
            power_kw: powerKw,
            energy_kwh: sessionEnergy ?? toFiniteNumber(meter.energy),
            eta_minutes: etaMinutes,
            soc: meterSoc,
            charging_rate_mode: this.chargingRateMode,
            estimated_capacity_kwh: estimatedCapacity,
            ...livePricing,
          };
          this._meterCache.set(key, snapshot);
          if (etaMinutes != null || ratePerMin > 0 || rateKw != null) {
            this.onEvent({
          type: 'meter_eta',
              charger_id: chargerId,
              connector_id: evt.connector_id,
              soc: meterSoc,
              rate_per_min: ratePerMin > 0 ? Math.round(ratePerMin * 100) / 100 : 0,
              rate_kw: rateKw != null ? Math.round(rateKw * 100) / 100 : null,
              eta_minutes: etaMinutes,
              charging_rate_mode: this.chargingRateMode,
              estimated_capacity_kwh: estimatedCapacity != null ? Math.round(estimatedCapacity * 100) / 100 : null,
              ...livePricing,
            });
          }
        }
        break;
      }

      case 'transaction_stopped': {
        if (chargerId && evt.connector_id != null) {
          this._meterCache.delete(`${chargerId}:${evt.connector_id}`);
        }
        const tx = raw
          .prepare(
            `SELECT * FROM transactions WHERE charger_id = ? AND ocpp_tx_id = ? AND status = 'active'
             ORDER BY id DESC LIMIT 1`
          )
          .get(chargerId, evt.transaction_id);
        if (tx) {
          const summary = evt.summary || {};
          const summarySocStart = toFiniteNumber(summary.started_at);
          const summarySocEnd = toFiniteNumber(summary.ended_at);
          if (summarySocStart == null || summarySocEnd == null) {
            raw.prepare('DELETE FROM transactions WHERE id = ?').run(tx.id);
            break;
          }
          raw
            .prepare(
              `UPDATE transactions SET stopped_at=?, duration_sec=?, energy_kwh=?,
                 soc_start=?, soc_end=?, status='stopped' WHERE id=?`
            )
            .run(
              now,
              summary.duration_sec ?? null,
              summary.energy_kwh ?? null,
              summarySocStart,
              summarySocEnd,
              tx.id
            );
          try {
            const bill = generateBillForTransaction(tx.id);
            this.onEvent({ type: 'bill_generated', bill, charger_id: chargerId });
          } catch (e) {
            this.onEvent({ type: 'bill_error', error: String(e), charger_id: chargerId });
          }
        }
        break;
      }
      default:
        break;
    }

    this.onEvent(evt);
  }

  _handleSnapshot(evt, now) {
    const raw = db.raw;
    const chargerId = evt.charger_id;
    if (!chargerId) return;

    raw
      .prepare(
        `INSERT INTO chargers (id, first_seen, last_seen, online)
         VALUES (?, ?, ?, 1)
         ON CONFLICT(id) DO UPDATE SET last_seen=excluded.last_seen, online=1`
      )
      .run(chargerId, now, now);

    for (const [connectorIdRaw, connector] of Object.entries(evt.connectors || {})) {
      const connectorId = Number(connectorIdRaw);
      if (!Number.isFinite(connectorId)) continue;
      const status = normalizeStatus(connector.status);
      const tx = connector.transaction || null;
      raw
        .prepare(
          `INSERT INTO connectors (charger_id, connector_id, status, error_code, updated_at)
           VALUES (?, ?, ?, NULL, ?)
           ON CONFLICT(charger_id, connector_id) DO UPDATE SET
             status=excluded.status, updated_at=excluded.updated_at`
        )
        .run(chargerId, connectorId, status || 'Unknown', now);

      if (tx) {
        const socStart = toFiniteNumber(tx.soc_start);
        const socEnd = toFiniteNumber(tx.soc_end);
        const energy = toFiniteNumber(tx.energy_kwh);
        const elapsed = toFiniteNumber(tx.elapsed_sec);
        const livePricing = calculateLivePricing(energy);
        this._meterCache.set(`${chargerId}:${connectorId}`, {
          lastTs: Date.now(),
          lastSoc: socEnd,
          ratePerMin: 0,
          rate_per_min: 0,
          rateKw: null,
          rate_kw: null,
          power_kw: null,
          energy_kwh: energy,
          eta_minutes: null,
          soc: socEnd,
          charging_rate_mode: this.chargingRateMode,
          estimated_capacity_kwh: null,
          session: tx,
          delta: null,
          ...livePricing,
        });

        if (socStart != null && socEnd != null) {
          const existing = raw
            .prepare(
              `SELECT id FROM transactions
               WHERE charger_id = ? AND connector_id = ? AND ocpp_tx_id = ? AND status = 'active'
               ORDER BY id DESC LIMIT 1`
            )
            .get(chargerId, connectorId, tx.transaction_id ?? null);
          if (existing) {
            raw
              .prepare(
                `UPDATE transactions SET duration_sec=?, energy_kwh=?, soc_start=?, soc_end=? WHERE id=?`
              )
              .run(elapsed, energy, socStart, socEnd, existing.id);
          } else {
            raw
              .prepare(
                `INSERT INTO transactions (charger_id, connector_id, ocpp_tx_id, started_at, duration_sec,
                   energy_kwh, soc_start, soc_end, status)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')`
              )
              .run(chargerId, connectorId, tx.transaction_id ?? null, now, elapsed, energy, socStart, socEnd);
          }
        }
      }
    }
  }
}

function toFiniteNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function hasSessionSocBounds(session) {
  if (!session) return false;
  return toFiniteNumber(session.soc_start) != null && toFiniteNumber(session.soc_end) != null;
}

function normalizeStatus(status) {
  if (status == null) return null;
  const value = typeof status === 'string' ? status : String(status);
  const last = value.split('.').pop();
  return last || value;
}

function calculateLivePricing(energyKwh) {
  const energy = toFiniteNumber(energyKwh);
  const shift = findShiftForTime(new Date());
  if (!shift || energy == null) {
    return {
      shift_id: shift ? shift.id : null,
      shift_name: shift ? shift.name : null,
      rate_per_kwh: shift ? toFiniteNumber(shift.rate_per_kwh) : null,
      tax_percent: shift && shift.tax_applicable === 1 ? toFiniteNumber(shift.tax_percent) || 0 : 0,
      subtotal: null,
      tax_amount: null,
      total_amount: null,
    };
  }
  const rate = toFiniteNumber(shift.rate_per_kwh) || 0;
  const subtotal = Math.round(energy * rate * 100) / 100;
  const taxPercent = shift.tax_applicable === 1 ? toFiniteNumber(shift.tax_percent) || 0 : 0;
  const taxAmount = Math.round(subtotal * (taxPercent / 100) * 100) / 100;
  return {
    shift_id: shift.id,
    shift_name: shift.name,
    rate_per_kwh: rate,
    tax_percent: taxPercent,
    subtotal,
    tax_amount: taxAmount,
    total_amount: Math.round((subtotal + taxAmount) * 100) / 100,
  };
}

function estimateBatteryCapacityKwh(session) {
  const energy = toFiniteNumber(session.energy);
  const socDelta = toFiniteNumber(session.soc_delta);
  if (energy == null || socDelta == null || energy <= 0 || socDelta <= 0) return null;
  return (energy / socDelta) * 100;
}

function estimateEtaFromKw({ soc, powerKw, capacityKwh }) {
  if (soc == null || powerKw == null || capacityKwh == null) return null;
  if (powerKw <= 0 || capacityKwh <= 0 || soc >= 100) return null;
  return Math.max(0, Math.round(((capacityKwh * (100 - soc)) / 100 / powerKw) * 60));
}

function estimateEtaFromPercent({ soc, ratePerMin }) {
  if (soc == null || ratePerMin == null || ratePerMin <= 0 || soc >= 100) return null;
  return Math.max(0, Math.round((100 - soc) / ratePerMin));
}

module.exports = { CsmsClient };
