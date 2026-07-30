import { describe, it, expect } from 'vitest';

describe('Utility functions', () => {
  describe('validateWsUrl', () => {
    it('accepts ws:// URLs', async () => {
      const { validateWsUrl } = await import('../utils.js');
      expect(validateWsUrl('ws://localhost:9000')).toBeNull();
    });

    it('accepts wss:// URLs', async () => {
      const { validateWsUrl } = await import('../utils.js');
      expect(validateWsUrl('wss://example.com/ocpp')).toBeNull();
    });

    it('rejects http:// URLs', async () => {
      const { validateWsUrl } = await import('../utils.js');
      const err = validateWsUrl('http://example.com');
      expect(err).not.toBeNull();
      expect(err.message).toContain('WebSocket');
    });

    it('rejects invalid URLs', async () => {
      const { validateWsUrl } = await import('../utils.js');
      const err = validateWsUrl('not-a-url');
      expect(err).not.toBeNull();
    });

    it('returns null for empty string (not configured)', async () => {
      const { validateWsUrl } = await import('../utils.js');
      expect(validateWsUrl('')).toBeNull();
    });
  });

  describe('validateHttpUrl', () => {
    it('accepts http:// URLs', async () => {
      const { validateHttpUrl } = await import('../utils.js');
      expect(validateHttpUrl('http://localhost:3000/api')).toBeNull();
    });

    it('accepts https:// URLs', async () => {
      const { validateHttpUrl } = await import('../utils.js');
      expect(validateHttpUrl('https://api.example.com')).toBeNull();
    });

    it('rejects ws:// URLs', async () => {
      const { validateHttpUrl } = await import('../utils.js');
      const err = validateHttpUrl('ws://localhost:9000');
      expect(err).not.toBeNull();
    });
  });
});

describe('Bill Template', () => {
  it('renderBillHtml dispatches correctly for professional format', async () => {
    const { renderBillHtml } = await import('../services/billTemplate.js');
    const bill = { bill_number: 'INV-001', company_name: 'Test Corp', energy_kwh: 10.5, rate_per_kwh: 0.15, subtotal: 1.58, tax_percent: 13, tax_amount: 0.21, total: 1.79, created_at: '2026-01-15T10:30:00Z' };
    const tx = { charger_id: 'CH-01', connector_id: 1, started_at: '2026-01-15T10:00:00Z', stopped_at: '2026-01-15T10:30:00Z', duration_sec: 1800, soc_start: 20, soc_end: 80 };
    const settings = { company_name: 'Test Corp', company_address: '123 Street', company_phone: '555-0100', company_email: 'a@b.com', company_footer: '', show_logo_on_bill: '1', service_fee: '0', service_charge: '0', bill_prefix: 'INV', use_new_bill_format: '0' };
    const html = renderBillHtml(bill, tx, settings, 'professional');
    expect(html).toContain('INV-001');
    expect(html).toContain('1.79');
    expect(html).toContain('10.500');
  });
});
