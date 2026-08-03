import { useState, useRef, useEffect } from 'react';

export const ENDPOINT_DOCS = {
  api_endpoint_bills: {
    label: 'Bills',
    method: 'POST',
    description: 'Sends generated invoices to your backend for permanent storage.',
    request: '{ id, bill_number, company_name, energy_kwh, rate_per_kwh, subtotal, tax_percent, tax_amount, total, created_at }',
    response: 'HTTP 200 OK on success',
  },
  api_endpoint_logs: {
    label: 'Logs',
    method: 'POST',
    description: 'Streams raw CSMS events (boot, heartbeat, status, transactions) to your backend for archiving.',
    request: '{ id, ts, charger_id, type, payload }',
    response: 'HTTP 200 OK on success',
  },
  api_endpoint_transactions: {
    label: 'Transactions',
    method: 'POST',
    description: 'Syncs completed charging sessions to your backend for billing reconciliation.',
    request: '{ id, charger_id, connector_id, started_at, stopped_at, energy_kwh, status }',
    response: 'HTTP 200 OK on success',
  },
  api_health_endpoint: {
    label: 'Health',
    method: 'GET',
    description: 'Health check endpoint that the app pings on startup and on demand to verify backend availability.',
    request: '—',
    response: 'HTTP 200 OK or  { "status": "ok" }',
  },
  default_battery_capacity_kwh: {
    label: 'Battery Capacity',
    method: 'ETA',
    description: 'Used only until the app can estimate capacity from session energy divided by SoC delta, multiplied by 100.',
    request: 'session.energy / session.soc_delta * 100',
    response: 'Estimated kWh capacity for kW-based ETA',
  },
  api_company_info_endpoint: {
    label: 'Company Info',
    method: 'GET',
    description: 'Full URL to fetch company details from. Response populates Company Name, Address, Phone, Email and logos in Branding settings.',
    request: '—',
    response: '{ company_name (fills Company Name), company_address, company_phone, company_email, branding_logo (URL, auto-downloaded to base64), invoice_logo (URL, auto-downloaded to base64) }',
  },
  api_bill_format_endpoint: {
    label: 'Bill Format',
    method: 'GET',
    description: 'Fetches an HTML bill template with {{keyword}} placeholders that get replaced at print time.',
    request: '—',
    response: 'HTML string with {{customer_name}}, {{customer_id}}, {{customer_pan}}, {{customer_address}}, {{customer_vehicle}}, {{company_name}}, {{bill_number}}, {{created_at}}, {{charger_id}}, {{connector_id}}, {{energy_kwh}}, {{rate_per_kwh}}, {{subtotal}}, {{tax_percent}}, {{tax_amount}}, {{service_fee}}, {{service_charge}}, {{total}}, {{soc_start}}, {{soc_end}}, {{started_at}}, {{stopped_at}}, {{duration_sec}}, {{rate_name}}',
  },
  api_customer_search_endpoint: {
    label: 'Customer Search',
    method: 'GET',
    description: 'Searches customers in real-time as the user types. Queried with ?q= prefix. When configured, a customer must be selected before starting a charger. Customer info flows into the transaction and bill.',
    request: 'GET ?q=<search query>',
    response: '[{ customer_id (required), customer_name (required), customer_pan, customer_address, customer_vehicle }]',
  },
  api_bill_number_endpoint: {
    label: 'Bill Number',
    method: 'GET',
    description: 'Fetches the next invoice number from the server before a bill is created. The number is pre-fetched and cached, so billing never blocks on the network; the local sequence is used as fallback while offline.',
    request: 'GET —',
    response: '{ bill_number: "INV-00042" } (also accepts next_bill_number, number, or a { data: {...} } wrapper)',
  },
  api_bill_details_endpoint: {
    label: 'Bill Details',
    method: 'GET',
    description: 'When the Custom display format is selected, the app fetches the bill from this endpoint (queried with ?bill_number=) and renders it with the remote template. Falls back to the local bill on failure.',
    request: 'GET ?bill_number=<number>',
    response: '{ bill_number, total, energy_kwh, ... } (or a { data: {...} } / { bill: {...} } wrapper)',
  },
  api_login_endpoint: {
    label: 'Login',
    method: 'POST',
    description: 'Login endpoint for token-based auth. The app POSTs { username, password } on startup and when the token expires, then uses the token as the Bearer header for all API calls. Falls back to the static API key when empty.',
    request: '{ username, password }',
    response: '{ access_token, expires_in } (also accepts token / jwt and token_lifetime / expires_at)',
  },
};

export default function FieldTooltip({ endpointKey }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  const doc = ENDPOINT_DOCS[endpointKey];
  if (!doc) return null;

  useEffect(() => {
    if (!open) return;
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <span ref={ref} style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
      <span
        onClick={() => setOpen(!open)}
        style={{
          cursor: 'pointer', fontSize: 13, color: 'var(--text-muted)',
          marginLeft: 4, userSelect: 'none', lineHeight: 1,
        }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10"/>
          <line x1="12" y1="16" x2="12" y2="12"/>
          <line x1="12" y1="8" x2="12.01" y2="8"/>
        </svg>
      </span>
      {open && (
        <div
          style={{
            position: 'absolute', left: 0, top: '100%', zIndex: 300,
            marginTop: 6, width: 320,
            background: 'var(--bg-surface)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-md)',
            padding: 14, boxShadow: 'var(--shadow)',
            fontSize: 12, lineHeight: 1.5,
          }}
        >
          <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6, color: 'var(--text-primary)' }}>
            {doc.method} — {doc.label}
          </div>
          <div style={{ color: 'var(--text-secondary)', marginBottom: 8 }}>{doc.description}</div>
          <div style={{ marginBottom: 4 }}>
            <span style={{ color: 'var(--text-muted)', fontWeight: 500 }}>Request:</span>
            <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: 'var(--amber)', marginTop: 2, wordBreak: 'break-all' }}>
              {doc.request}
            </div>
          </div>
          <div>
            <span style={{ color: 'var(--text-muted)', fontWeight: 500 }}>Response:</span>
            <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: 'var(--teal)', marginTop: 2 }}>
              {doc.response}
            </div>
          </div>
        </div>
      )}
    </span>
  );
}
