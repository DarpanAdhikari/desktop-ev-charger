import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import path from 'path';

import syncWorker from '../services/syncWorker.js';

const raw = new DatabaseSync(':memory:');
raw.exec(fs.readFileSync(path.join(process.cwd(), 'main', 'db', 'schema.sql'), 'utf8'));

function makeSettings(overrides = {}) {
  return {
    api_base_url: 'https://api.example.com',
    api_endpoint_bills: '/api/bills',
    api_endpoint_logs: '/api/logs',
    api_endpoint_transactions: '/api/transactions',
    api_key: '',
    skip_ssl_verify: '0',
    ...overrides,
  };
}

function seedBillRow() {
  const info = raw
    .prepare(
      `INSERT INTO transactions (charger_id, connector_id, ocpp_tx_id, started_at, status, energy_kwh)
       VALUES ('CHG-1', 1, 10, ?, 'stopped', 4.2)`
    )
    .run(new Date().toISOString());
  const txId = info.lastInsertRowid;
  const billInfo = raw
    .prepare(
      `INSERT INTO bills (transaction_id, bill_number, total, created_at)
       VALUES (?, ?, 100, ?)`
    )
    .run(txId, 'INV-00001', new Date().toISOString());
  return { txId, billId: billInfo.lastInsertRowid };
}

function enqueue(entityType, entityId, endpointKey, overrides = {}) {
  const now = new Date().toISOString();
  return raw
    .prepare(
      `INSERT INTO sync_queue (entity_type, entity_id, endpoint_key, payload, status, attempts, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(entityType, entityId, endpointKey, JSON.stringify({ id: entityId }), overrides.status || 'pending', overrides.attempts || 0, now).lastInsertRowid;
}

describe('SyncWorker', () => {
  let sender;

  beforeEach(() => {
    raw.exec('DELETE FROM sync_queue');
    raw.exec('DELETE FROM bills');
    raw.exec('DELETE FROM transactions');
    sender = vi.fn(async () => ({ statusCode: 200, body: '{}' }));
    syncWorker.setDeps({
      db: { raw, getSettings: () => makeSettings() },
      sender,
      apiAuth: {
        authHeaders: async (extra = {}) => ({ 'Content-Type': 'application/json', ...extra }),
        clearToken: vi.fn(),
      },
    });
  });

  it('marks the queue row sent and sets synced=1 on 2xx', async () => {
    const { billId } = seedBillRow();
    const rowId = enqueue('bill', billId, 'api_endpoint_bills');

    await syncWorker.drainOnce();

    const row = raw.prepare('SELECT * FROM sync_queue WHERE id = ?').get(rowId);
    expect(row.status).toBe('sent');
    expect(row.attempts).toBe(1);
    const bill = raw.prepare('SELECT * FROM bills WHERE id = ?').get(billId);
    expect(bill.synced).toBe(1);
  });

  it('stores the server bill id returned in the response body', async () => {
    sender.mockResolvedValue({ statusCode: 201, body: JSON.stringify({ id: 77, bill_number: 'INV-0099' }) });
    const { billId } = seedBillRow();
    enqueue('bill', billId, 'api_endpoint_bills');

    await syncWorker.drainOnce();

    const bill = raw.prepare('SELECT * FROM bills WHERE id = ?').get(billId);
    expect(bill.server_bill_id).toBe('77');
  });

  it('does not store a server bill id when the response has none', async () => {
    sender.mockResolvedValue({ statusCode: 200, body: '{}' });
    const { billId } = seedBillRow();
    enqueue('bill', billId, 'api_endpoint_bills');

    await syncWorker.drainOnce();

    const bill = raw.prepare('SELECT * FROM bills WHERE id = ?').get(billId);
    expect(bill.server_bill_id).toBeNull();
  });

  it('builds the URL from base + endpoint path and sends the payload', async () => {
    const { billId } = seedBillRow();
    enqueue('bill', billId, 'api_endpoint_bills');

    await syncWorker.drainOnce();

    expect(sender).toHaveBeenCalledTimes(1);
    const [url, opts] = sender.mock.calls[0];
    expect(url).toBe('https://api.example.com/api/bills');
    expect(opts.method).toBe('POST');
    expect(opts.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(opts.body)).toEqual({ id: billId });
  });

  it('sends the Bearer token when an API key is configured', async () => {
    syncWorker.setDeps({
      db: { raw, getSettings: () => makeSettings({ api_key: 'secret' }) },
      sender,
      apiAuth: {
        authHeaders: async () => ({ 'Content-Type': 'application/json', Authorization: 'Bearer secret' }),
        clearToken: vi.fn(),
      },
    });
    const { billId } = seedBillRow();
    enqueue('bill', billId, 'api_endpoint_bills');

    await syncWorker.drainOnce();

    const opts = sender.mock.calls[0][1];
    expect(opts.headers.Authorization).toBe('Bearer secret');
  });

  it('re-logins once on 401 and retries the row', async () => {
    const clearToken = vi.fn();
    let first = true;
    syncWorker.setDeps({
      db: { raw, getSettings: () => makeSettings({ api_key: '' }) },
      sender: vi.fn(async () => {
        if (first) { first = false; return { statusCode: 401, body: 'unauthorized' }; }
        return { statusCode: 200, body: '{}' };
      }),
      apiAuth: {
        authHeaders: async () => {
          if (first) return { 'Content-Type': 'application/json', Authorization: 'Bearer expired' };
          return { 'Content-Type': 'application/json', Authorization: 'Bearer fresh' };
        },
        clearToken,
      },
    });
    const { billId } = seedBillRow();
    const rowId = enqueue('bill', billId, 'api_endpoint_bills');

    await syncWorker.drainOnce();

    const row = raw.prepare('SELECT * FROM sync_queue WHERE id = ?').get(rowId);
    expect(row.status).toBe('sent');
    expect(clearToken).toHaveBeenCalledTimes(1);
  });

  it('retries on HTTP errors and keeps the row pending with attempts bumped', async () => {
    sender.mockResolvedValue({ statusCode: 500, body: 'boom' });
    const { billId } = seedBillRow();
    const rowId = enqueue('bill', billId, 'api_endpoint_bills');

    await syncWorker.drainOnce();

    const row = raw.prepare('SELECT * FROM sync_queue WHERE id = ?').get(rowId);
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(1);
    expect(row.last_error).toContain('500');
  });

  it('marks the row failed after MAX attempts', async () => {
    sender.mockRejectedValue(new Error('network down'));
    const { billId } = seedBillRow();
    const rowId = enqueue('bill', billId, 'api_endpoint_bills', { attempts: 7 });

    await syncWorker.drainOnce();

    const row = raw.prepare('SELECT * FROM sync_queue WHERE id = ?').get(rowId);
    expect(row.status).toBe('failed');
    expect(row.attempts).toBe(8);
  });

  it('skips rows whose endpoint is not configured', async () => {
    const { billId } = seedBillRow();
    const billRowId = enqueue('bill', billId, 'api_endpoint_bills');
    syncWorker.setDeps({
      db: {
        raw,
        getSettings: () => makeSettings({ api_endpoint_bills: '' }),
      },
      sender,
    });

    await syncWorker.drainOnce();

    const skipped = raw.prepare('SELECT * FROM sync_queue WHERE id = ?').get(billRowId);
    expect(skipped.status).toBe('pending');
    expect(sender).not.toHaveBeenCalled();
  });

  it('does nothing when api_base_url is not configured', async () => {
    const { billId } = seedBillRow();
    enqueue('bill', billId, 'api_endpoint_bills');
    syncWorker.setDeps({
      db: { raw, getSettings: () => makeSettings({ api_base_url: '' }) },
      sender,
    });

    await syncWorker.drainOnce();

    expect(sender).not.toHaveBeenCalled();
  });

  it('honors skip_ssl_verify for the sender', async () => {
    const { billId } = seedBillRow();
    enqueue('bill', billId, 'api_endpoint_bills');
    syncWorker.setDeps({
      db: { raw, getSettings: () => makeSettings({ skip_ssl_verify: '1' }) },
      sender,
    });

    await syncWorker.drainOnce();

    expect(sender.mock.calls[0][1].rejectUnauthorized).toBe(false);
  });

  it('passes rejectUnauthorized=true when skip_ssl_verify is off', async () => {
    const { billId } = seedBillRow();
    enqueue('bill', billId, 'api_endpoint_bills');

    await syncWorker.drainOnce();

    expect(sender.mock.calls[0][1].rejectUnauthorized).toBe(true);
  });

  it('does not touch synced flags for log rows', async () => {
    const rowId = enqueue('log', 1, 'api_endpoint_logs');

    await syncWorker.drainOnce();

    const row = raw.prepare('SELECT * FROM sync_queue WHERE id = ?').get(rowId);
    expect(row.status).toBe('sent');
  });
});
