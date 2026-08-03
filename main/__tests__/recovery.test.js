import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import path from 'path';

import recovery from '../services/recovery.js';

const raw = new DatabaseSync(':memory:');
raw.exec(fs.readFileSync(path.join(process.cwd(), 'main', 'db', 'schema.sql'), 'utf8'));

const fakeBilling = {
  generateBillForTransaction: (txId) => {
    const tx = raw.prepare('SELECT * FROM transactions WHERE id = ?').get(txId);
    if (!tx) throw new Error(`transaction ${txId} not found`);
    const billNumber = `TEST-${txId}`;
    raw
      .prepare(
        `INSERT INTO bills (transaction_id, bill_number, energy_kwh, total, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(txId, billNumber, tx.energy_kwh || 0, (tx.energy_kwh || 0) * 2, new Date().toISOString());
    return raw.prepare('SELECT * FROM bills WHERE transaction_id = ?').get(txId);
  }
};

function seedCharger(chargerId = 'CHG-1') {
  raw
    .prepare(
      `INSERT INTO chargers (id, vendor, model, first_seen, last_seen, online)
       VALUES (?, 'ACME', 'X1', ?, ?, 1)`
    )
    .run(chargerId, new Date().toISOString(), new Date().toISOString());
}

function seedConnector(chargerId, connectorId, status = 'Available') {
  raw
    .prepare(
      `INSERT INTO connectors (charger_id, connector_id, status, error_code, updated_at)
       VALUES (?, ?, ?, NULL, ?)`
    )
    .run(chargerId, connectorId, status, new Date().toISOString());
}

function seedActiveTx(chargerId, connectorId, ocppTxId = 100, energy = 5.5, customer = null) {
  const c = customer || {};
  const info = raw
    .prepare(
      `INSERT INTO transactions
         (charger_id, connector_id, ocpp_tx_id, started_at, status, energy_kwh, soc_start, soc_end,
          customer_id, customer_name)
       VALUES (?, ?, ?, ?, 'active', ?, 40, 80, ?, ?)`
    )
    .run(chargerId, connectorId, ocppTxId, new Date().toISOString(), energy,
      c.customer_id || null, c.customer_name || null);
  return raw.prepare('SELECT * FROM transactions WHERE id = ?').get(info.lastInsertRowid);
}

describe('Recovery', () => {
  let events;

  beforeEach(() => {
    raw.exec('DELETE FROM bills');
    raw.exec('DELETE FROM transactions');
    raw.exec('DELETE FROM connectors');
    raw.exec('DELETE FROM chargers');
    raw.exec('DELETE FROM sync_queue');
    raw.exec('DELETE FROM logs');
    events = [];
    recovery.setDeps({
      db: { raw, getSettings: () => ({ recovery_grace_sec: '120' }) },
      billing: fakeBilling,
    });
    recovery.setEventHandler((evt) => events.push(evt));
    recovery.setMeterProvider(() => null);
  });

  describe('reconcileFromSnapshot', () => {
    it('finalizes an active session the server no longer reports', () => {
      seedCharger();
      seedConnector('CHG-1', 1, 'Available');
      const tx = seedActiveTx('CHG-1', 1);

      recovery.reconcileFromSnapshot({
        charger_id: 'CHG-1',
        connectors: { '1': { status: 'Available', transaction: null } },
      });

      const updated = raw.prepare('SELECT * FROM transactions WHERE id = ?').get(tx.id);
      expect(updated.status).toBe('stopped');
      expect(updated.billed).toBe(1);
      expect(updated.energy_kwh).toBe(5.5);
      const bill = raw.prepare('SELECT * FROM bills WHERE transaction_id = ?').get(tx.id);
      expect(bill.bill_number).toBe('TEST-' + tx.id);
      expect(events.some((e) => e.type === 'session_recovered')).toBe(true);
    });

    it('keeps a session active when the server still reports the same transaction', () => {
      seedCharger();
      seedConnector('CHG-1', 1, 'Charging');
      const tx = seedActiveTx('CHG-1', 1, 100);

      recovery.reconcileFromSnapshot({
        charger_id: 'CHG-1',
        connectors: { '1': { status: 'Charging', transaction: { transaction_id: 100, soc_start: 40, soc_end: 80 } } },
      });

      const updated = raw.prepare('SELECT * FROM transactions WHERE id = ?').get(tx.id);
      expect(updated.status).toBe('active');
      expect(updated.flagged).toBe(1);
      expect(updated.flag_reason).toBe('resumed_after_outage');
      expect(events.some((e) => e.type === 'session_attention')).toBe(true);
      expect(events.some((e) => e.type === 'session_recovered')).toBe(false);
    });

    it('finalizes when the server has a different transaction on the connector', () => {
      seedCharger();
      seedConnector('CHG-1', 1, 'Charging');
      const tx = seedActiveTx('CHG-1', 1, 100);

      recovery.reconcileFromSnapshot({
        charger_id: 'CHG-1',
        connectors: { '1': { status: 'Charging', transaction: { transaction_id: 999 } } },
      });

      const updated = raw.prepare('SELECT * FROM transactions WHERE id = ?').get(tx.id);
      expect(updated.status).toBe('stopped');
    });

    it('is idempotent: a second snapshot does not double-bill', () => {
      seedCharger();
      seedConnector('CHG-1', 1, 'Available');
      const tx = seedActiveTx('CHG-1', 1);

      recovery.reconcileFromSnapshot({ charger_id: 'CHG-1', connectors: { '1': { status: 'Available', transaction: null } } });
      recovery.reconcileFromSnapshot({ charger_id: 'CHG-1', connectors: { '1': { status: 'Available', transaction: null } } });

      const bills = raw.prepare('SELECT COUNT(*) as c FROM bills WHERE transaction_id = ?').get(tx.id);
      expect(bills.c).toBe(1);
    });

    it('derives stopped_at from started_at plus the session duration', () => {
      seedCharger();
      seedConnector('CHG-1', 1, 'Available');
      const startedAt = new Date('2026-07-26T11:41:41.000Z');
      const info = raw
        .prepare(
          `INSERT INTO transactions (charger_id, connector_id, ocpp_tx_id, started_at, status, energy_kwh, soc_start, soc_end)
           VALUES (?, ?, 7, ?, 'active', 2.5, 40, 80)`
        )
        .run('CHG-1', 1, startedAt.toISOString());
      const tx = raw.prepare('SELECT * FROM transactions WHERE id = ?').get(info.lastInsertRowid);
      recovery.setMeterProvider(() => ({ session: { energy: 2.5, elapsed_sec: 1499, soc_start: 40, soc_end: 80 } }));

      recovery.reconcileFromSnapshot({
        charger_id: 'CHG-1',
        connectors: { '1': { status: 'Available', transaction: null } },
      });

      const updated = raw.prepare('SELECT * FROM transactions WHERE id = ?').get(tx.id);
      expect(updated.stopped_at).toBe(new Date(startedAt.getTime() + 1499 * 1000).toISOString());
      expect(updated.duration_sec).toBe(1499);
    });
  });

  describe('recoverOnStartup', () => {
    function seedLog(ts, type, payload) {
      raw
        .prepare('INSERT INTO logs (ts, charger_id, type, payload) VALUES (?, ?, ?, ?)')
        .run(ts, payload.charger_id || 'CHG-1', type, JSON.stringify(payload));
    }

    it('closes a session when the last log is a stopped summary (crash between log and finalize)', () => {
      seedCharger();
      seedConnector('CHG-1', 1, 'Available');
      const tx = seedActiveTx('CHG-1', 1, 100, 9.99);
      const stoppedAt = new Date().toISOString();
      seedLog(stoppedAt, 'transaction_stopped', {
        type: 'transaction_stopped', charger_id: 'CHG-1', connector_id: 1, transaction_id: 100,
        summary: { duration_sec: 500, energy_kwh: 3.2, soc_start: 30, soc_end: 55, customer_name: 'Alice' },
      });

      recovery.recoverOnStartup();

      const updated = raw.prepare('SELECT * FROM transactions WHERE id = ?').get(tx.id);
      expect(updated.status).toBe('stopped');
      expect(updated.billed).toBe(1);
      expect(updated.energy_kwh).toBe(3.2);
      expect(updated.duration_sec).toBe(500);
      expect(updated.stopped_at).toBe(stoppedAt);
      expect(updated.customer_name).toBe('Alice');
    });

    it('closes a stale session from its last meter reading in the logs', () => {
      seedCharger();
      seedConnector('CHG-1', 1, 'Available');
      const tx = seedActiveTx('CHG-1', 1, 100, 9.99);
      seedLog(new Date(Date.now() - 10 * 60 * 1000).toISOString(), 'meter', {
        type: 'meter', charger_id: 'CHG-1', connector_id: 1, transaction_id: 100,
        session: { elapsed_sec: 900, energy: 4.5, soc_start: 20, soc_end: 70 },
        meter: { energy: 1200.5 },
      });

      recovery.recoverOnStartup();

      const updated = raw.prepare('SELECT * FROM transactions WHERE id = ?').get(tx.id);
      expect(updated.status).toBe('stopped');
      expect(updated.billed).toBe(1);
      expect(updated.energy_kwh).toBe(4.5);
      expect(updated.duration_sec).toBe(900);
      expect(updated.soc_start).toBe(20);
      expect(updated.soc_end).toBe(70);
    });

    it('leaves a session alone when its logs look recent (may still be live)', () => {
      seedCharger();
      seedConnector('CHG-1', 1, 'Charging');
      const tx = seedActiveTx('CHG-1', 1, 100, 2.2);
      seedLog(new Date().toISOString(), 'meter', {
        type: 'meter', charger_id: 'CHG-1', connector_id: 1, transaction_id: 100,
        session: { elapsed_sec: 60, energy: 0.3, soc_start: 20, soc_end: 25 },
      });

      recovery.recoverOnStartup();

      const updated = raw.prepare('SELECT * FROM transactions WHERE id = ?').get(tx.id);
      expect(updated.status).toBe('active');
      expect(updated.billed).toBe(0);
    });

    it('flags a stale session with no usable log data instead of fabricating a bill', () => {
      seedCharger();
      seedConnector('CHG-1', 1, 'Available');
      const tx = seedActiveTx('CHG-1', 1, 100, 1.1);
      seedLog(new Date(Date.now() - 10 * 60 * 1000).toISOString(), 'heartbeat', {
        type: 'heartbeat', charger_id: 'CHG-1', connector_id: 1,
      });

      recovery.recoverOnStartup();

      const updated = raw.prepare('SELECT * FROM transactions WHERE id = ?').get(tx.id);
      expect(updated.status).toBe('active');
      expect(updated.flagged).toBe(1);
      expect(updated.flag_reason).toBe('recovery_no_data');
    });

    it('finalizes from log data when the snapshot path has no live cache', () => {
      seedCharger();
      seedConnector('CHG-1', 1, 'Available');
      const startedAt = new Date('2026-07-26T11:41:41.000Z');
      const info = raw
        .prepare(
          `INSERT INTO transactions (charger_id, connector_id, ocpp_tx_id, started_at, status, energy_kwh)
           VALUES (?, ?, 42, ?, 'active', 0)`
        )
        .run('CHG-1', 1, startedAt.toISOString());
      const tx = raw.prepare('SELECT * FROM transactions WHERE id = ?').get(info.lastInsertRowid);
      raw
        .prepare('INSERT INTO logs (ts, charger_id, type, payload) VALUES (?, ?, ?, ?)')
        .run(
          new Date(Date.now() - 10 * 60 * 1000).toISOString(),
          'CHG-1',
          'meter',
          JSON.stringify({
            type: 'meter', charger_id: 'CHG-1', connector_id: 1, transaction_id: 42,
            session: { elapsed_sec: 1499, energy: 2.5, soc_start: 40, soc_end: 80 },
          })
        );

      recovery.reconcileFromSnapshot({
        charger_id: 'CHG-1',
        connectors: { '1': { status: 'Available', transaction: null } },
      });

      const updated = raw.prepare('SELECT * FROM transactions WHERE id = ?').get(tx.id);
      expect(updated.status).toBe('stopped');
      expect(updated.energy_kwh).toBe(2.5);
      expect(updated.stopped_at).toBe(new Date(startedAt.getTime() + 1499 * 1000).toISOString());
    });
  });

  describe('forceCloseSession', () => {
    it('closes an active session using recent data and bills it', () => {
      seedCharger();
      seedConnector('CHG-1', 1, 'Faulted');
      const tx = seedActiveTx('CHG-1', 1, 100, 7.25, { customer_id: 'CUST-1', customer_name: 'Binita' });

      const result = recovery.forceCloseSession(tx.id);

      expect(result.success).toBe(true);
      const updated = raw.prepare('SELECT * FROM transactions WHERE id = ?').get(tx.id);
      expect(updated.status).toBe('stopped');
      expect(updated.billed).toBe(1);
      expect(updated.customer_id).toBe('CUST-1');
      expect(result.bill.bill_number).toBe('TEST-' + tx.id);
      expect(events.some((e) => e.type === 'session_closed')).toBe(true);
    });

    it('rejects a session that has no customer attached', () => {
      seedCharger();
      seedConnector('CHG-1', 1, 'Faulted');
      const tx = seedActiveTx('CHG-1', 1);

      const result = recovery.forceCloseSession(tx.id);

      expect(result.success).toBe(false);
      expect(result.reason).toBe('no_customer');
      const updated = raw.prepare('SELECT * FROM transactions WHERE id = ?').get(tx.id);
      expect(updated.status).toBe('active');
    });

    it('rejects a transaction that is already closed', () => {
      seedCharger();
      seedConnector('CHG-1', 1, 'Faulted');
      const tx = seedActiveTx('CHG-1', 1, 100, 5.5, { customer_id: 'CUST-1', customer_name: 'Binita' });
      recovery.forceCloseSession(tx.id);
      const result = recovery.forceCloseSession(tx.id);
      expect(result.success).toBe(false);
    });
  });

  describe('retryBilling', () => {
    it('bills a stopped transaction that has no bill', () => {
      seedCharger();
      seedConnector('CHG-1', 1, 'Available');
      const info = raw
        .prepare(
          `INSERT INTO transactions (charger_id, connector_id, ocpp_tx_id, started_at, stopped_at, status, energy_kwh)
           VALUES ('CHG-1', 1, 55, ?, ?, 'stopped', 3.2)`
        )
        .run(new Date().toISOString(), new Date().toISOString());

      const result = recovery.retryBilling(info.lastInsertRowid);

      expect(result.success).toBe(true);
      const tx = raw.prepare('SELECT * FROM transactions WHERE id = ?').get(info.lastInsertRowid);
      expect(tx.billed).toBe(1);
    });

    it('rejects already-billed transactions', () => {
      seedCharger();
      seedConnector('CHG-1', 1, 'Available');
      const tx = seedActiveTx('CHG-1', 1, 100, 5.5, { customer_id: 'CUST-1', customer_name: 'Binita' });
      recovery.forceCloseSession(tx.id);
      const result = recovery.retryBilling(tx.id);
      expect(result.success).toBe(false);
      expect(result.reason).toBe('already_billed');
    });
  });

  describe('checkAttention', () => {
    it('flags active sessions on connectors that went silent', () => {
      seedCharger();
      seedConnector('CHG-1', 1, 'Charging');
      const tx = seedActiveTx('CHG-1', 1);
      raw
        .prepare('UPDATE connectors SET updated_at = ? WHERE charger_id = ? AND connector_id = ?')
        .run(new Date(Date.now() - 10 * 60 * 1000).toISOString(), 'CHG-1', 1);
      raw
        .prepare('UPDATE chargers SET last_seen = ? WHERE id = ?')
        .run(new Date(Date.now() - 10 * 60 * 1000).toISOString(), 'CHG-1');

      recovery.checkAttention();

      const updated = raw.prepare('SELECT * FROM transactions WHERE id = ?').get(tx.id);
      expect(updated.flagged).toBe(1);
      expect(updated.flag_reason).toBe('connector_offline');
      expect(events.some((e) => e.type === 'session_attention')).toBe(true);
    });

    it('does not flag sessions whose connector is still fresh', () => {
      seedCharger();
      seedConnector('CHG-1', 1, 'Charging');
      const tx = seedActiveTx('CHG-1', 1);

      recovery.checkAttention();

      const updated = raw.prepare('SELECT * FROM transactions WHERE id = ?').get(tx.id);
      expect(updated.flagged).toBe(0);
    });
  });

  describe('flagFaulted', () => {
    it('flags an active session when the connector faults', () => {
      seedCharger();
      seedConnector('CHG-1', 1, 'Faulted');
      const tx = seedActiveTx('CHG-1', 1);

      recovery.flagFaulted('CHG-1', 1);

      const updated = raw.prepare('SELECT * FROM transactions WHERE id = ?').get(tx.id);
      expect(updated.flagged).toBe(1);
      expect(updated.flag_reason).toBe('connector_fault');
    });
  });
});
