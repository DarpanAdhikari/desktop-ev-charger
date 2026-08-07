const WebSocket = require('ws');
const db = require('../db/db');
const { generateBillForTransaction, findShiftForTime } = require('./billing');
const recovery = require('./recovery');
const { RECONNECT_DELAY_MS, METER_RECONCILE_TOLERANCE_KWH } = require('../constants');

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

    // Keep every server-side event for audit: full raw payloads land in logs
    // and are queued for sync. Only heartbeats are skipped - they carry no
    // payload and their liveness info is already tracked in the chargers table.
    const shouldPersistEvent = evt.type !== 'heartbeat';
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
        recovery.reconcileFromSnapshot(evt);
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
        // The server's transaction_started carries the cumulative meter
        // counter at session start (evt.energy). Anchor it here; the meter
        // handler only fills it when it is still NULL (see below).
        const startMeterKwh = toFiniteNumber(evt.energy);
        raw
          .prepare(
            `INSERT INTO transactions (charger_id, connector_id, ocpp_tx_id, started_at, status,
              customer_id, customer_name, customer_pan, customer_address, customer_vehicle, server_data,
              meter_energy_start_kwh)
             VALUES (?, ?, ?, ?, 'active',
              ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(chargerId, evt.connector_id, evt.transaction_id, now,
            customerId, customerName, customerPan, customerAddress, customerVehicle,
            JSON.stringify(evt), startMeterKwh);
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
          if (powerKw === 0) {
            // Honest idle state: no energy is being delivered, so the rate drops to 0.
            ratePerMin = 0;
          } else if (meterSoc != null && prev && prev.lastSoc != null && meterSoc !== prev.lastSoc) {
            const elapsedMs = meterTs - prev.lastTs;
            if (elapsedMs > 0) {
              ratePerMin = ((meterSoc - prev.lastSoc) / elapsedMs) * 60000;
            }
          }
          // Current power is the raw reading, including 0. Only fall back when the
          // reading is missing entirely (e.g. a snapshot-restored cache).
          const rateKw = powerKw != null ? powerKw : prev ? prev.rateKw : null;
          const powerPrevKw = prev && prev.lastPowerKw != null ? prev.lastPowerKw : null;
          const serverDelta = evt.delta || null;
          const powerDeltaKw = toFiniteNumber(serverDelta && serverDelta.power) ??
            (powerKw != null && powerPrevKw != null ? powerKw - powerPrevKw : null);
          // Running session power stats (max/avg/last) for the receipt.
          const maxPowerKw = powerKw != null
            ? Math.max(powerKw, prev && prev.maxPowerKw != null ? prev.maxPowerKw : 0)
            : (prev ? prev.maxPowerKw : null);
          const powerCount = (prev ? prev.powerCount : 0) + (powerKw != null ? 1 : 0);
          const powerSumKw = (prev ? prev.powerSumKw : 0) + (powerKw != null ? powerKw : 0);
          const avgPowerKw = powerCount > 0 ? powerSumKw / powerCount : null;
          const estimatedCapacity = estimateBatteryCapacityKwh(session) || this.defaultBatteryCapacityKwh;
          const etaMinutes = this.chargingRateMode === 'kw'
            ? estimateEtaFromKw({ soc: meterSoc, powerKw: rateKw, capacityKwh: estimatedCapacity })
            : estimateEtaFromPercent({ soc: meterSoc, ratePerMin });
          const sessionEnergy = toFiniteNumber(session.energy);
          const sessionElapsed = toFiniteNumber(session.elapsed_sec);
          const sessionSocStart = toFiniteNumber(session.soc_start);
          const sessionSocEnd = toFiniteNumber(session.soc_end);
          const meterEnergy = toFiniteNumber(meter.energy);
          const energyDeltaKwh = toFiniteNumber(serverDelta && serverDelta.energy);
          const livePricing = calculateLivePricing(sessionEnergy);
          if (sessionSocStart != null && sessionSocEnd != null) {
            raw
              .prepare(
                `UPDATE transactions SET
                   energy_kwh=COALESCE(?, energy_kwh),
                   soc_start=COALESCE(soc_start, ?),
                   soc_end=COALESCE(?, soc_end),
                   duration_sec=COALESCE(?, duration_sec),
                   max_power_kw=?,
                   avg_power_kw=?,
                   last_power_kw=?
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
                maxPowerKw,
                avgPowerKw != null ? Math.round(avgPowerKw * 100) / 100 : null,
                powerKw,
                chargerId,
                evt.connector_id
              );
          }
          if (meterEnergy != null) {
            // Cumulative meter counter at session start and end: the counter when
            // the session began is invariant during the session and equals
            // meter.energy - session.energy, so end - start == delivered kWh.
            const meterStartEnergy = sessionEnergy != null ? meterEnergy - sessionEnergy : null;
            raw
              .prepare(
                `UPDATE transactions SET
                   meter_energy_start_kwh=CASE WHEN meter_energy_start_kwh IS NULL THEN ? ELSE meter_energy_start_kwh END,
                   meter_energy_end_kwh=?
                 WHERE id = (
                   SELECT id FROM transactions
                   WHERE charger_id = ? AND connector_id = ? AND status = 'active'
                   ORDER BY id DESC LIMIT 1
                 )`
              )
              .run(
                meterStartEnergy,
                meterEnergy,
                chargerId,
                evt.connector_id
              );
          }
          // Keep the full server payload with the session so no field is lost.
          raw
            .prepare(
              `UPDATE transactions SET server_data = ?
               WHERE id = (
                 SELECT id FROM transactions
                 WHERE charger_id = ? AND connector_id = ? AND status = 'active'
                 ORDER BY id DESC LIMIT 1
               )`
            )
            .run(JSON.stringify(evt), chargerId, evt.connector_id);
          const snapshot = {
            lastTs: meterTs,
            lastSoc: meterSoc,
            lastPowerKw: powerKw,
            maxPowerKw,
            powerSumKw,
            powerCount,
            meter,
            delta: serverDelta,
            session,
            ratePerMin,
            rate_per_min: ratePerMin > 0 ? Math.round(ratePerMin * 100) / 100 : 0,
            rateKw,
            rate_kw: rateKw != null ? Math.round(rateKw * 100) / 100 : null,
            power_kw: powerKw,
            power_prev_kw: powerPrevKw,
            power_delta_kw: powerDeltaKw != null ? Math.round(powerDeltaKw * 100) / 100 : null,
            max_power_kw: maxPowerKw != null ? Math.round(maxPowerKw * 100) / 100 : null,
            avg_power_kw: avgPowerKw != null ? Math.round(avgPowerKw * 100) / 100 : null,
            last_power_kw: powerKw,
            energy_kwh: sessionEnergy,
            meter_energy_kwh: meterEnergy,
            energy_delta_kwh: energyDeltaKwh != null ? Math.round(energyDeltaKwh * 100) / 100 : null,
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
              power_kw: powerKw,
              power_prev_kw: powerPrevKw,
              power_delta_kw: powerDeltaKw != null ? Math.round(powerDeltaKw * 100) / 100 : null,
              max_power_kw: maxPowerKw != null ? Math.round(maxPowerKw * 100) / 100 : null,
              avg_power_kw: avgPowerKw != null ? Math.round(avgPowerKw * 100) / 100 : null,
              last_power_kw: powerKw,
              energy_kwh: sessionEnergy,
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
          // The server names these started_at/ended_at but actually sends the SoC
          // at start/end (values are 0-100). Guard with a sanity check so a future
          // server change to real timestamps degrades to the safe missing_soc path.
          const summarySocStart = toFiniteNumber(summary.started_at);
          const summarySocEnd = toFiniteNumber(summary.ended_at);
          const hasSoc = summarySocStart != null && summarySocEnd != null &&
            summarySocStart <= 100 && summarySocEnd <= 100;
          const durationSec = toFiniteNumber(summary.duration_sec);
          // The server sends no absolute end time; the session duration is the
          // only trustworthy value, so derive the end time from the real start.
          const stoppedAt = durationSec != null && tx.started_at
            ? new Date(new Date(tx.started_at).getTime() + durationSec * 1000).toISOString()
            : now;
          const finalizeSql = hasSoc
            ? `UPDATE transactions SET stopped_at=?, duration_sec=?, energy_kwh=?,
                 soc_start=?, soc_end=?, status='stopped', flagged=0, flag_reason=NULL WHERE id=?`
            : `UPDATE transactions SET stopped_at=?, duration_sec=?, energy_kwh=?,
                 status='stopped', flagged=1, flag_reason='missing_soc' WHERE id=?`;
          raw
            .prepare(finalizeSql)
            .run(
              stoppedAt,
              durationSec,
              summary.energy_kwh ?? null,
              ...(hasSoc ? [summarySocStart, summarySocEnd] : []),
              tx.id
            );
          // Meter window: the server's summary carries the authoritative
          // cumulative counter at stop (summary.energy); prefer it over the
          // derived value. Derive a missing start from end - billed (and
          // missing end from start + billed) so the receipt always reconciles.
          // If the counters contradict the billed energy beyond rounding, the
          // session was mis-measured - flag for operator verification rather
          // than silently billing from inconsistent readings.
          const billedEnergy = toFiniteNumber(summary.energy_kwh);
          const summaryMeterEndKwh = toFiniteNumber(summary.energy);
          const meterStartKwh = toFiniteNumber(tx.meter_energy_start_kwh);
          let meterStartFinal = meterStartKwh;
          let meterEndFinal = summaryMeterEndKwh;
          if (meterEndFinal == null) {
            if (meterStartFinal != null && billedEnergy != null) {
              meterEndFinal = meterStartFinal + billedEnergy;
            }
          } else if (meterStartFinal == null && billedEnergy != null) {
            meterStartFinal = meterEndFinal - billedEnergy;
          }
          if (meterStartFinal != null || meterEndFinal != null) {
            if (meterStartFinal != null && meterEndFinal != null && billedEnergy != null &&
                Math.abs(meterEndFinal - meterStartFinal - billedEnergy) > METER_RECONCILE_TOLERANCE_KWH) {
              raw
                .prepare("UPDATE transactions SET flagged = 1, flag_reason = ? WHERE id = ? AND flagged = 0")
                .run('meter_mismatch', tx.id);
            }
            raw
              .prepare(
                `UPDATE transactions SET meter_energy_start_kwh = COALESCE(?, meter_energy_start_kwh),
                   meter_energy_end_kwh = ? WHERE id = ?`
              )
              .run(meterStartFinal, meterEndFinal, tx.id);
          }
          // Keep the full stopped payload (summary etc.) with the session.
          raw.prepare('UPDATE transactions SET server_data = ? WHERE id = ?')
            .run(JSON.stringify(evt), tx.id);
          try {
            const bill = generateBillForTransaction(tx.id);
            raw.prepare('UPDATE transactions SET billed = 1 WHERE id = ?').run(tx.id);
            recovery.queueTransactionSync(tx.id);
            this.onEvent({ type: 'bill_generated', bill, charger_id: chargerId });
          } catch (e) {
            this.onEvent({ type: 'bill_error', error: String(e), charger_id: chargerId, tx_id: tx.id });
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
        // Keep running power stats if this connector already had a live session
        // (snapshots arrive periodically and must not reset the receipt stats).
        const prevCache = this._meterCache.get(`${chargerId}:${connectorId}`);
        const maxPowerKw = prevCache && prevCache.maxPowerKw != null ? prevCache.maxPowerKw : null;
        const powerSumKw = prevCache && prevCache.powerSumKw != null ? prevCache.powerSumKw : 0;
        const powerCount = prevCache && prevCache.powerCount != null ? prevCache.powerCount : 0;
        const lastPowerKw = prevCache && prevCache.lastPowerKw != null ? prevCache.lastPowerKw : null;
        const avgPowerKw = powerCount > 0 ? powerSumKw / powerCount : null;
        this._meterCache.set(`${chargerId}:${connectorId}`, {
          lastTs: Date.now(),
          lastSoc: socEnd,
          lastPowerKw,
          maxPowerKw,
          powerSumKw,
          powerCount,
          ratePerMin: 0,
          rate_per_min: 0,
          rateKw: null,
          rate_kw: null,
          power_kw: lastPowerKw,
          power_prev_kw: null,
          power_delta_kw: null,
          max_power_kw: maxPowerKw != null ? Math.round(maxPowerKw * 100) / 100 : null,
          avg_power_kw: avgPowerKw != null ? Math.round(avgPowerKw * 100) / 100 : null,
          last_power_kw: lastPowerKw,
          energy_kwh: energy,
          meter_energy_kwh: null,
          energy_delta_kwh: null,
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
                `UPDATE transactions SET duration_sec=?, energy_kwh=?, soc_start=?, soc_end=?, server_data=? WHERE id=?`
              )
              .run(elapsed, energy, socStart, socEnd, JSON.stringify(evt), existing.id);
          } else {
            // The server sends no absolute start time; the snapshot's elapsed_sec
            // is the only trustworthy value, so backdate the start by it.
            const startedAt = elapsed != null
              ? new Date(Date.parse(now) - elapsed * 1000).toISOString()
              : now;
            raw
              .prepare(
                `INSERT INTO transactions (charger_id, connector_id, ocpp_tx_id, started_at, duration_sec,
                   energy_kwh, soc_start, soc_end, status, server_data)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`
              )
              .run(chargerId, connectorId, tx.transaction_id ?? null, startedAt, elapsed, energy, socStart, socEnd, JSON.stringify(evt));
          }
        }
      }
    }
  }
}

function toFiniteNumber(value) {
  if (value == null || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
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
