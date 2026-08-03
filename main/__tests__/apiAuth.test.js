import { describe, it, expect } from 'vitest';
import apiAuth from '../services/apiAuth.js';
import billNumber from '../services/billNumber.js';

describe('apiAuth.parseLoginResponse', () => {
  it('parses a flat access_token with expires_in', () => {
    const r = apiAuth.parseLoginResponse(JSON.stringify({ access_token: 'tok', expires_in: 3600 }));
    expect(r.token).toBe('tok');
    expect(new Date(r.expiresAt).getTime()).toBeGreaterThan(Date.now() + 3500 * 1000);
    expect(new Date(r.expiresAt).getTime()).toBeLessThanOrEqual(Date.now() + 3600 * 1000);
  });

  it('parses a nested data wrapper with token + token_lifetime', () => {
    const r = apiAuth.parseLoginResponse(JSON.stringify({ data: { token: 'nested', token_lifetime: 7200 } }));
    expect(r.token).toBe('nested');
    expect(new Date(r.expiresAt).getTime()).toBeGreaterThan(Date.now() + 7100 * 1000);
  });

  it('returns a token with no expiry when none is provided', () => {
    const r = apiAuth.parseLoginResponse(JSON.stringify({ token: 'plain' }));
    expect(r.token).toBe('plain');
    expect(r.expiresAt).toBeNull();
  });

  it('returns null for non-JSON or token-less bodies', () => {
    expect(apiAuth.parseLoginResponse('not json')).toBeNull();
    expect(apiAuth.parseLoginResponse('{"error":"bad"}')).toBeNull();
  });
});

describe('apiAuth.isTokenValid', () => {
  it('accepts a token without an expiry', () => {
    expect(apiAuth.isTokenValid({ api_token: 'tok' })).toBe(true);
  });

  it('rejects a token without a value', () => {
    expect(apiAuth.isTokenValid({ api_token: '' })).toBe(false);
    expect(apiAuth.isTokenValid({})).toBe(false);
  });

  it('accepts a token whose expiry is in the future (with 30s margin)', () => {
    const future = new Date(Date.now() + 60000).toISOString();
    expect(apiAuth.isTokenValid({ api_token: 'tok', api_token_expires_at: future })).toBe(true);
  });

  it('rejects an expired token', () => {
    const past = new Date(Date.now() - 1000).toISOString();
    expect(apiAuth.isTokenValid({ api_token: 'tok', api_token_expires_at: past })).toBe(false);
  });
});

describe('billNumber.parseNextBillNumber', () => {
  it('parses bill_number at the root or nested in data', () => {
    expect(billNumber.parseNextBillNumber('{"bill_number":"INV-00042"}')).toBe('INV-00042');
    expect(billNumber.parseNextBillNumber('{"data":{"bill_number":"INV-00043"}}')).toBe('INV-00043');
    expect(billNumber.parseNextBillNumber('{"next_bill_number":"INV-00044"}')).toBe('INV-00044');
    expect(billNumber.parseNextBillNumber('{"number":"INV-00045"}')).toBe('INV-00045');
  });

  it('returns null for unparseable or number-less bodies', () => {
    expect(billNumber.parseNextBillNumber('nope')).toBeNull();
    expect(billNumber.parseNextBillNumber('{"ok":true}')).toBeNull();
  });
});
