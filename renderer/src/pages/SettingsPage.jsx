import { useState, useEffect, useCallback } from 'react';
import { useSettings } from '../hooks/useVoltDesk';
import { listPrinters, testPrinter, dbBackup, dbRestore, resetApp, checkHealth, pickImage, fetchCompanyInfo, bluetoothScan, bluetoothConnect, bluetoothDisconnect, bluetoothList, bluetoothTest } from '../services/ipc';
import FieldTooltip, { ENDPOINT_DOCS } from '../components/FieldTooltip';

const WS_SCHEMES = ['ws:', 'wss:'];
const HTTP_SCHEMES = ['http:', 'https:'];

function validateUrl(url, allowedSchemes, label) {
  if (!url || !url.trim()) return null;
  try {
    const parsed = new URL(url);
    if (!allowedSchemes.includes(parsed.protocol)) {
      return `${label} must use ${allowedSchemes.map((s) => s.replace(':', '')).join(' or ')} protocol`;
    }
    return null;
  } catch {
    return `${label} is not a valid URL`;
  }
}

export default function SettingsPage({ addToast, triggerRefresh }) {
  const { settings, shifts, loading, refresh, saveSettings, saveShift, removeShift } = useSettings();
  const [form, setForm] = useState({});
  const [errors, setErrors] = useState({});
  const [savingSection, setSavingSection] = useState(null);
  const [printers, setPrinters] = useState([]);
  const [btDevices, setBtDevices] = useState([]);
  const [btScanning, setBtScanning] = useState(false);
  const [activeTab, setActiveTab] = useState('connection');

  useEffect(() => {
    listPrinters().then(setPrinters).catch(() => {});
  }, []);

  useEffect(() => {
    if (settings) {
      setForm((prev) => ({ ...prev, ...settings }));
    }
  }, [settings]);

  const updateField = (key, value) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => ({ ...prev, [key]: null }));
  };

  const validateConnection = useCallback(() => {
    const e = {};
    const wsErr = validateUrl(form.ws_url, WS_SCHEMES, 'WebSocket URL');
    if (wsErr) e.ws_url = wsErr;
    setErrors((prev) => ({ ...prev, ...e }));
    return Object.keys(e).length === 0;
  }, [form.ws_url]);

  const validateBackend = useCallback(() => {
    const e = {};
    const apiErr = validateUrl(form.api_base_url, HTTP_SCHEMES, 'API base URL');
    if (apiErr) e.api_base_url = apiErr;
    setErrors((prev) => ({ ...prev, ...e }));
    return Object.keys(e).length === 0;
  }, [form.api_base_url]);

  const saveSection = async (section, patch, validateFn) => {
    if (validateFn && !validateFn()) {
      addToast('Please fix validation errors before saving.', 'error');
      return;
    }
    setSavingSection(section);
    try {
      await saveSettings(patch);
      addToast(`${section} saved.`, 'success');
      if (triggerRefresh) triggerRefresh();
    } catch (e) {
      addToast(`Failed to save ${section.toLowerCase()}: ${e.message}`, 'error');
    } finally {
      setSavingSection(null);
    }
  };

  const addShift = () => {
    saveShift({
      name: 'New Shift',
      start_time: '00:00',
      end_time: '23:59',
      rate_per_kwh: '0.10',
      tax_applicable: false,
      tax_percent: '0',
      active: true,
    }).then(() => addToast('Shift added.', 'info'));
  };

  const handleResetApp = async () => {
    let configuredPin = settings.pin_code || form.pin_code || '';
    if (!configuredPin) {
      const nextPin = window.prompt('Set a 4-6 digit PIN before resetting the app.');
      if (!nextPin) return;
      if (!/^\d{4,6}$/.test(nextPin)) {
        addToast('PIN must be 4-6 digits.', 'error');
        return;
      }
      await saveSettings({ pin_code: nextPin });
      updateField('pin_code', nextPin);
      configuredPin = nextPin;
      addToast('PIN saved. Enter it again to reset the app.', 'info');
    }

    const enteredPin = window.prompt('Enter PIN to reset the app.');
    if (!enteredPin) return;
    if (enteredPin !== configuredPin) {
      addToast('Incorrect PIN. Reset canceled.', 'error');
      return;
    }
    if (!window.confirm('Reset App will clear settings, shifts, chargers, logs, transactions, bills, and local sync queue. Continue?')) return;

    const result = await resetApp({ pin: enteredPin });
    if (!result.success) {
      addToast(result.reason === 'invalid_pin' ? 'Incorrect PIN. Reset canceled.' : `Reset failed: ${result.reason}`, 'error');
      return;
    }
    addToast('App reset successfully.', 'success');
    if (triggerRefresh) triggerRefresh();
    window.location.reload();
  };

  if (loading || !settings) {
    return (
      <div style={{ padding: '28px 32px' }}>
        <header className="view-header">
          <div className="skeleton" style={{ width: 160, height: 28, marginBottom: 8 }} />
          <div className="skeleton" style={{ width: 240, height: 16 }} />
        </header>
        <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
          {[1,2,3,4,5,6,7].map((i) => (
            <div key={i} className="skeleton" style={{ width: 80, height: 32, borderRadius: 8 }} />
          ))}
        </div>
        <div className="skeleton" style={{ width: '100%', height: 400, borderRadius: 10 }} />
      </div>
    );
  }

  const TABS = [
    { id: 'connection', label: 'Connection' },
    { id: 'branding', label: 'Branding & Invoice' },
    { id: 'pricing', label: 'Rate & Shifts' },
    { id: 'printers', label: 'Printers' },
    { id: 'backend', label: 'Backend Sync' },
    { id: 'security', label: 'Security' },
    { id: 'maintenance', label: 'Maintenance' },
  ];
  return (
    <>
      <header className="view-header">
        <h1>Settings</h1>
        <p className="muted">Connection, branding, rate, shifts, printers, tax and sync.</p>
      </header>

      <nav className="settings-tabs">
        {TABS.map((t) => (
          <button key={t.id} className={`settings-tab${activeTab === t.id ? ' active' : ''}`} onClick={() => setActiveTab(t.id)}>{t.label}</button>
        ))}
      </nav>

      {activeTab === 'connection' && (
        <div className="settings-card">
          <h2>Connection</h2>
          <div className="form-group">
            <label>CSMS WebSocket URL</label>
            <input
              value={form.ws_url || ''}
              onChange={(e) => updateField('ws_url', e.target.value)}
              placeholder="ws://host:port or wss://host:port"
            />
            {errors.ws_url && <div className="field-error">{errors.ws_url}</div>}
          </div>
          <div className="form-group" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <label className="toggle-switch">
              <input
                type="checkbox"
                id="skip_ssl"
                checked={form.skip_ssl_verify === '1'}
                onChange={(e) => updateField('skip_ssl_verify', e.target.checked ? '1' : '0')}
              />
              <span className="toggle-slider"></span>
            </label>
            <label htmlFor="skip_ssl" style={{ margin: 0, cursor: 'pointer' }}>
              Skip SSL verification
            </label>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              (for expired/self-signed certificates)
            </span>
          </div>
          <button
            className="btn primary"
            disabled={savingSection === 'Connection'}
            onClick={() => saveSection('Connection', {
              ws_url: form.ws_url || '',
              skip_ssl_verify: form.skip_ssl_verify || '0',
            }, validateConnection)}
          >
            {savingSection === 'Connection' ? 'Saving...' : 'Save Connection'}
          </button>
        </div>
      )}

      {activeTab === 'branding' && (
        <div className="settings-card">
          <h2>Branding & Invoice</h2>
          {(form.api_base_url && form.api_company_info_endpoint) && (
            <div className="form-group">
              <button className="btn ghost" style={{ padding: '6px 12px', fontSize: 11 }}
                onClick={async () => {
                  const info = await fetchCompanyInfo();
                  if (!info) { addToast('Failed to fetch company info', 'error'); return; }
                  if (info.company_name) updateField('company_name', info.company_name);
                  if (info.company_address) updateField('company_address', info.company_address);
                  if (info.company_phone) updateField('company_phone', info.company_phone);
                  if (info.company_email) updateField('company_email', info.company_email);
                  if (info.branding_logo) updateField('branding_logo', info.branding_logo);
                  if (info.invoice_logo) updateField('invoice_logo', info.invoice_logo);
                  addToast('Company info updated from API', 'success');
                }}
              >Fetch from API</button>
            </div>
          )}
          <div className="form-group">
            <label>Company Name</label>
            <input value={form.company_name || ''} onChange={(e) => updateField('company_name', e.target.value)} />
          </div>
          <div className="form-group">
            <label>Company Address</label>
            <input value={form.company_address || ''} onChange={(e) => updateField('company_address', e.target.value)} />
          </div>
          <div className="form-group">
            <label>Company Phone</label>
            <input value={form.company_phone || ''} onChange={(e) => updateField('company_phone', e.target.value)} />
          </div>
          <div className="form-group">
            <label>Company Email</label>
            <input value={form.company_email || ''} onChange={(e) => updateField('company_email', e.target.value)} />
          </div>
          <div className="form-group">
            <label>Print Footer</label>
            <input value={form.company_footer || ''} onChange={(e) => updateField('company_footer', e.target.value)} placeholder="e.g. © My Company (https://example.com)" />
            <p style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>Shown at bottom of printed bills only (not in preview)</p>
          </div>
          <div className="form-group">
            <label>Branding Logo</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {form.branding_logo ? (
                <img src={form.branding_logo} alt="Branding" style={{ width: 80, height: 60, objectFit: 'contain', borderRadius: 6, background: '#1a1a1a' }} />
              ) : (
                <div style={{ width: 80, height: 60, borderRadius: 6, background: '#1a1a1a', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, color: '#666' }}>No logo</div>
              )}
              <button className="btn ghost" style={{ padding: '4px 12px', fontSize: 11 }} onClick={async () => {
                const r = await pickImage();
                if (r && !r.canceled) updateField('branding_logo', r.data);
              }}>Upload</button>
              {form.branding_logo && (
                <button className="btn ghost" style={{ padding: '4px 12px', fontSize: 11, color: 'var(--red)' }} onClick={() => updateField('branding_logo', '')}>Clear</button>
              )}
            </div>
          </div>
          <div className="form-group">
            <label>Invoice Logo</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {form.invoice_logo ? (
                <img src={form.invoice_logo} alt="Invoice" style={{ width: 80, height: 60, objectFit: 'contain', borderRadius: 6, background: '#1a1a1a' }} />
              ) : (
                <div style={{ width: 80, height: 60, borderRadius: 6, background: '#1a1a1a', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, color: '#666' }}>No logo</div>
              )}
              <button className="btn ghost" style={{ padding: '4px 12px', fontSize: 11 }} onClick={async () => {
                const r = await pickImage();
                if (r && !r.canceled) updateField('invoice_logo', r.data);
              }}>Upload</button>
              {form.invoice_logo && (
                <button className="btn ghost" style={{ padding: '4px 12px', fontSize: 11, color: 'var(--red)' }} onClick={() => updateField('invoice_logo', '')}>Clear</button>
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6 }}>
              <label className="toggle-switch">
                <input
                  type="checkbox"
                  id="show_logo"
                  checked={form.show_logo_on_bill === '1'}
                  onChange={(e) => updateField('show_logo_on_bill', e.target.checked ? '1' : '0')}
                />
                <span className="toggle-slider"></span>
              </label>
              <label htmlFor="show_logo" style={{ margin: 0, cursor: 'pointer', fontSize: 12 }}>Show logo on invoice</label>
            </div>
            <div className="form-group" style={{ marginTop: 8 }}>
              <label>Screen / Print Format</label>
              <div className="radio-row" style={{ flexWrap: 'wrap' }}>
                <label>
                  <input
                    type="radio"
                    name="bill_display_format"
                    value="professional"
                    checked={(form.bill_display_format || 'professional') === 'professional'}
                    onChange={(e) => updateField('bill_display_format', e.target.value)}
                  />
                  Professional
                </label>
                <label>
                  <input
                    type="radio"
                    name="bill_display_format"
                    value="enhanced"
                    checked={form.bill_display_format === 'enhanced'}
                    onChange={(e) => updateField('bill_display_format', e.target.value)}
                  />
                  Enhanced
                </label>
                <label>
                  <input
                    type="radio"
                    name="bill_display_format"
                    value="original"
                    checked={form.bill_display_format === 'original'}
                    onChange={(e) => updateField('bill_display_format', e.target.value)}
                  />
                  Original
                </label>
                {form.api_bill_format_endpoint && (
                  <label>
                    <input
                      type="radio"
                      name="bill_display_format"
                      value="custom"
                      checked={form.bill_display_format === 'custom'}
                      onChange={(e) => updateField('bill_display_format', e.target.value)}
                    />
                    Custom
                  </label>
                )}
              </div>
              {form.bill_display_format === 'custom' && (
                <p style={{ fontSize: 10, color: 'var(--amber)', marginTop: 4 }}>Using remote bill format from API endpoint</p>
              )}
            </div>
          </div>
          <div className="form-group">
            <label>Bill Number Prefix</label>
            <input value={form.bill_prefix || 'INV'} onChange={(e) => updateField('bill_prefix', e.target.value)} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div className="form-group">
              <label>Service Fee (per session)</label>
              <input type="number" min="0" step="0.01" value={form.service_fee || ''} onChange={(e) => updateField('service_fee', e.target.value)} placeholder="0.00" />
            </div>
            <div className="form-group">
              <label>Service Charge (per session)</label>
              <input type="number" min="0" step="0.01" value={form.service_charge || ''} onChange={(e) => updateField('service_charge', e.target.value)} placeholder="0.00" />
            </div>
          </div>
          <button
            className="btn primary"
            disabled={savingSection === 'Branding'}
            onClick={() => saveSection('Branding', {
              company_name: form.company_name || '',
              company_address: form.company_address || '',
              company_phone: form.company_phone || '',
              company_email: form.company_email || '',
              company_footer: form.company_footer || '',
              branding_logo: form.branding_logo || '',
              invoice_logo: form.invoice_logo || '',
              show_logo_on_bill: form.show_logo_on_bill || '0',
              bill_display_format: form.bill_display_format || 'professional',
              service_fee: form.service_fee || '0',
              service_charge: form.service_charge || '0',
              bill_prefix: form.bill_prefix || 'INV',
            })}
          >
            {savingSection === 'Branding' ? 'Saving...' : 'Save Branding'}
          </button>
        </div>
      )}

      {activeTab === 'pricing' && (
        <div className="settings-card">
          <h2>Charging Rate</h2>
          <div className="form-group">
            <label>Rate Display</label>
            <div className="radio-row">
              <label>
                <input
                  type="radio"
                  name="charging_rate_mode"
                  value="percentage"
                  checked={(form.charging_rate_mode || 'percentage') === 'percentage'}
                  onChange={(e) => updateField('charging_rate_mode', e.target.value)}
                />
                SoC (%)
              </label>
              <label>
                <input
                  type="radio"
                  name="charging_rate_mode"
                  value="kw"
                  checked={form.charging_rate_mode === 'kw'}
                  onChange={(e) => updateField('charging_rate_mode', e.target.value)}
                />
                Power (kW)
              </label>
            </div>
          </div>
          {form.charging_rate_mode === 'kw' && (
            <div className="form-group">
              <label>
                Default Battery Capacity (kWh)
                <FieldTooltip endpointKey="default_battery_capacity_kwh" />
              </label>
              <input
                type="number"
                min="0"
                step="0.1"
                value={form.default_battery_capacity_kwh || ''}
                onChange={(e) => updateField('default_battery_capacity_kwh', e.target.value)}
                placeholder="Optional"
              />
            </div>
          )}
          <hr style={{ border: 'none', borderTop: '1px solid #333', margin: '16px 0' }} />
          <h2>Shifts & Tax</h2>
          {shifts.map((shift) => (
            <ShiftRow key={shift.id} shift={shift} onSave={saveShift} onDelete={removeShift} />
          ))}
          <button className="btn ghost" onClick={addShift} style={{ marginTop: 8 }}>+ Add shift</button>
          <div style={{ marginTop: 20 }}>
            <button
              className="btn primary"
              disabled={savingSection === 'Rate & Shifts'}
              onClick={() => saveSection('Rate & Shifts', {
                charging_rate_mode: form.charging_rate_mode === 'kw' ? 'kw' : 'percentage',
                default_battery_capacity_kwh: form.default_battery_capacity_kwh || '',
              })}
            >
              {savingSection === 'Rate & Shifts' ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>
      )}

      {activeTab === 'backend' && (
        <div className="settings-card">
          <h2>Backend Sync</h2>
          <div style={{ display: 'flex', gap: 12 }}>
            <div className="form-group" style={{ flex: 2 }}>
              <label>API Base URL</label>
              <input
                value={form.api_base_url || ''}
                onChange={(e) => updateField('api_base_url', e.target.value)}
                placeholder="https://your-server.com"
              />
              {errors.api_base_url && <div className="field-error">{errors.api_base_url}</div>}
            </div>
            <div className="form-group" style={{ flex: 1 }}>
              <label>API Key</label>
              <input type="password" value={form.api_key || ''} onChange={(e) => updateField('api_key', e.target.value)} />
            </div>
          </div>
          <hr style={{ border: 'none', borderTop: '1px solid #333', margin: '16px 0' }} />
          {[
            { key: 'api_endpoint_bills', placeholder: '/api/bills' },
            { key: 'api_endpoint_logs', placeholder: '/api/logs' },
            { key: 'api_endpoint_transactions', placeholder: '/api/transactions' },
            { key: 'api_health_endpoint', placeholder: '/api/health', test: true },
            { key: 'api_company_info_endpoint', placeholder: '/api/company' },
            { key: 'api_bill_format_endpoint', placeholder: '/api/bill/template' },
            { key: 'api_customer_search_endpoint', placeholder: '/api/customers/search' },
          ].map(({ key, placeholder, test }) => {
            const doc = ENDPOINT_DOCS[key] || null;
            return (
              <div key={key} style={{ marginBottom: 16, border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: 12 }}>
                <div style={{ display: 'flex', gap: 12 }}>
                  <div className="form-group" style={{ flex: 1, marginBottom: 0 }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontSize: 10, fontWeight: 600, color: '#fff', background: doc?.method === 'GET' ? 'var(--teal)' : 'var(--amber)', padding: '1px 6px', borderRadius: 4 }}>{doc?.method || '?'}</span>
                      {doc?.label || key}
                    </label>
                    <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
                      <input value={form[key] || ''} onChange={(e) => updateField(key, e.target.value)} placeholder={placeholder} style={{ flex: 1 }} />
                      {test && (
                        <button className="btn ghost" style={{ padding: '6px 12px', fontSize: 11, whiteSpace: 'nowrap' }}
                          onClick={async () => {
                            const r = await checkHealth();
                            if (r.ok) addToast(`API health: ${r.status} (${r.latency}ms)`, 'success');
                            else if (r.reason === 'not_configured') addToast('API Base URL not configured', 'error');
                            else addToast(`API health failed: ${r.reason} (${r.latency}ms)`, 'error');
                          }}
                        >Test</button>
                      )}
                    </div>
                  </div>
                  <div style={{ flex: 1, fontSize: 11, color: 'var(--text-muted)' }}>
                    <div style={{ fontWeight: 500, marginBottom: 4 }}>Expected Response</div>
                    {doc?.request && doc.request !== '—' && (
                      <div style={{ marginBottom: 4 }}>
                        <span style={{ color: 'var(--text-secondary)' }}>Request body:</span>
                        <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: 'var(--amber)', marginTop: 2 }}>{doc.request}</div>
                      </div>
                    )}
                    <div>
                      <span style={{ color: 'var(--text-secondary)' }}>Response:</span>
                      <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: 'var(--teal)', marginTop: 2 }}>{doc?.response || '—'}</div>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
          <button
            className="btn primary"
            disabled={savingSection === 'Backend Sync'}
            onClick={() => saveSection('Backend Sync', {
              api_base_url: form.api_base_url || '',
              api_endpoint_bills: form.api_endpoint_bills || '',
              api_endpoint_logs: form.api_endpoint_logs || '',
              api_endpoint_transactions: form.api_endpoint_transactions || '',
              api_health_endpoint: form.api_health_endpoint || '',
              api_key: form.api_key || '',
              api_company_info_endpoint: form.api_company_info_endpoint || '',
              api_bill_format_endpoint: form.api_bill_format_endpoint || '',
              api_customer_search_endpoint: form.api_customer_search_endpoint || '',
            }, validateBackend)}
          >
            {savingSection === 'Backend Sync' ? 'Saving...' : 'Save Backend Sync'}
          </button>
        </div>
      )}

      {activeTab === 'printers' && (
        <div className="settings-card">
          <h2>Printers</h2>
          <div className="form-group">
            <label>Printer Type</label>
            <div className="radio-row">
              <label>
                <input
                  type="radio"
                  name="printer_type"
                  value="system"
                  checked={(form.printer_type || 'system') === 'system'}
                  onChange={(e) => updateField('printer_type', e.target.value)}
                />
                System Printer
              </label>
              <label>
                <input
                  type="radio"
                  name="printer_type"
                  value="network"
                  checked={form.printer_type === 'network'}
                  onChange={(e) => updateField('printer_type', e.target.value)}
                />
                Network (TCP/IP)
              </label>
              <label>
                <input
                  type="radio"
                  name="printer_type"
                  value="bluetooth"
                  checked={form.printer_type === 'bluetooth'}
                  onChange={(e) => updateField('printer_type', e.target.value)}
                />
                Bluetooth (COM)
              </label>
            </div>
          </div>

          <hr style={{ border: 'none', borderTop: '1px solid #333', margin: '16px 0' }} />

          <div className="form-group">
            <label>Print Format</label>
            <select value={form.bill_format || 'thermal_80mm'} onChange={(e) => updateField('bill_format', e.target.value)}>
              <option value="thermal_80mm">Thermal</option>
              <option value="a4">A4</option>
            </select>
          </div>

          <div className="form-group">
            <label>Paper Width</label>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
                <input type="radio" name="paper_width_opt" checked={form.paper_width === '80' || !form.paper_width} onChange={() => updateField('paper_width', '80')} />
                80mm
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
                <input type="radio" name="paper_width_opt" checked={form.paper_width === '58'} onChange={() => updateField('paper_width', '58')} />
                58mm
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
                <input type="radio" name="paper_width_opt" checked={form.paper_width !== '80' && form.paper_width !== '58' && form.paper_width} onChange={() => updateField('paper_width', '')} />
                Custom
              </label>
              <input type="number" min="30" max="120" value={(form.paper_width !== '80' && form.paper_width !== '58' && form.paper_width) ? form.paper_width : ''} onChange={(e) => updateField('paper_width', e.target.value)} placeholder="mm" style={{ width: 64, display: (form.paper_width !== '80' && form.paper_width !== '58') ? 'inline-block' : 'none' }} />
            </div>
          </div>

          {(form.printer_type === 'network' || form.printer_type === 'bluetooth') && (
            <div className="form-group">
              <label>Thermal Print Mode</label>
              <div className="radio-row">
                <label>
                  <input
                    type="radio"
                    name="thermal_print_mode"
                    value="raster"
                    checked={(form.thermal_print_mode || 'raster') === 'raster'}
                    onChange={(e) => updateField('thermal_print_mode', e.target.value)}
                  />
                  Raster (logo + format)
                </label>
                <label>
                  <input
                    type="radio"
                    name="thermal_print_mode"
                    value="text"
                    checked={form.thermal_print_mode === 'text'}
                    onChange={(e) => updateField('thermal_print_mode', e.target.value)}
                  />
                  Text (plain, fast)
                </label>
              </div>
            </div>
          )}

          {form.printer_type === 'system' && (
            <>
              <div className="form-group">
                <label>Printer</label>
                <select value={form.print_device_name || ''} onChange={(e) => updateField('print_device_name', e.target.value)}>
                  <option value="">— Default printer —</option>
                  {printers.map((p) => (
                    <option key={p.name} value={p.name}>{p.displayName || p.name}</option>
                  ))}
                </select>
              </div>
            </>
          )}

          {form.printer_type === 'network' && (
            <>
              <div className="form-group">
                <label>IP Address</label>
                <input value={form.printer_network_ip || ''} onChange={(e) => updateField('printer_network_ip', e.target.value)} placeholder="192.168.1.100" />
              </div>
              <div className="form-group">
                <label>Port</label>
                <input type="number" min="1" max="65535" value={form.printer_network_port || '9100'} onChange={(e) => updateField('printer_network_port', e.target.value)} placeholder="9100" />
              </div>
            </>
          )}

          {form.printer_type === 'bluetooth' && (
            <div className="form-group">
              <label>Bluetooth Printer</label>
              <div style={{ display: 'flex', gap: 4, marginBottom: 6 }}>
                <button className="btn ghost" style={{ padding: '6px 12px', fontSize: 11, whiteSpace: 'nowrap' }}
                  disabled={btScanning}
                  onClick={async () => {
                    setBtScanning(true);
                    try {
                      const devices = await bluetoothScan();
                      setBtDevices(devices || []);
                      addToast(`Found ${(devices||[]).length} device(s)`, 'success');
                    } catch (e) {
                      addToast(`Scan failed: ${e.message}`, 'error');
                    } finally {
                      setBtScanning(false);
                    }
                  }}
                >{btScanning ? 'Scanning...' : '🔍 Scan'}</button>
              </div>
              {btDevices.length > 0 && (
                <div style={{ maxHeight: 200, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 6, marginBottom: 6 }}>
                  {btDevices.map((d, i) => {
                    const selected = form.bt_printer_address && (form.bt_printer_address === d.address || form.bt_printer_address === d.macAddress);
                    return (
                    <div key={d.address || d.macAddress || i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderBottom: i < btDevices.length - 1 ? '1px solid var(--border)' : 'none', background: selected ? 'var(--accent-bg)' : 'transparent' }}>
                      <span style={{ flex: 1, fontSize: 12 }}>
                        <strong>{d.name || 'Unknown'}</strong>
                        <span style={{ color: 'var(--text-muted)', marginLeft: 8 }}>{d.macAddress || d.address}</span>
                        {d.com_port && <span style={{ color: 'var(--text-muted)', marginLeft: 4 }}>({d.com_port})</span>}
                        {selected && <span style={{ marginLeft: 6, fontSize: 10, color: 'var(--success)' }}>✓ Selected</span>}
                      </span>
                      {d.address && (
                        selected ? (
                          <button className="btn ghost" style={{ padding: '2px 8px', fontSize: 10, color: 'var(--danger)' }}
                            onClick={async () => {
                              try {
                                await bluetoothDisconnect(d.address);
                                updateField('bt_printer_address', '');
                                updateField('bt_printer_name', '');
                                addToast('Disconnected', 'success');
                              } catch (e) {
                                addToast(`Disconnect failed: ${e.message}`, 'error');
                              }
                            }}
                          >Disconnect</button>
                        ) : (
                          <button className="btn ghost" style={{ padding: '2px 8px', fontSize: 10, color: 'var(--primary)' }}
                            onClick={async () => {
                              try {
                                await bluetoothConnect(d.address);
                                updateField('bt_printer_address', d.address);
                                updateField('bt_printer_name', d.name || '');
                                addToast(`Connected to ${d.name || d.address}`, 'success');
                              } catch (e) {
                                addToast(`Connect failed: ${e.message}`, 'error');
                              }
                            }}
                          >Connect</button>
                        )
                      )}
                    </div>
                    );
                  })}
                </div>
              )}
              {btDevices.length === 0 && (
                <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                  Click <strong>Scan</strong> to discover nearby Bluetooth printers.
                </p>
              )}
            </div>
          )}

          <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
            <button
              className="btn primary"
              disabled={savingSection === 'Printers'}
              onClick={() => saveSection('Printers', {
                printer_type: form.printer_type || 'system',
                printer_network_ip: form.printer_network_ip || '',
                printer_network_port: form.printer_network_port || '9100',
                bt_printer_address: form.bt_printer_address || '',
                bt_printer_name: form.bt_printer_name || '',
                thermal_print_mode: form.thermal_print_mode || 'raster',
                bill_format: form.bill_format || 'thermal_80mm',
                print_device_name: form.print_device_name || '',
                paper_width: form.paper_width || '80',
              })}
            >
              {savingSection === 'Printers' ? 'Saving...' : 'Save Printers'}
            </button>
            <button className="btn ghost" style={{ padding: '6px 12px', fontSize: 11 }}
              onClick={async () => {
                const type = form.printer_type || 'system';
                const result = await testPrinter({
                  printerType: type,
                  ip: form.printer_network_ip,
                  port: form.printer_network_port,
                  comName: form.bt_printer_address,
                });
                if (result.success) addToast('Test page sent to printer', 'success');
                else addToast(`Test failed: ${result.failureReason || result.reason}`, 'error');
              }}
            >Test Print</button>
          </div>
        </div>
      )}

      {activeTab === 'security' && (
        <div className="settings-card">
          <h2>Security</h2>
          <div className="form-group">
            <label>PIN Code (for locking the app)</label>
            <input
              type="password"
              value={form.pin_code || ''}
              onChange={(e) => updateField('pin_code', e.target.value)}
              placeholder="4-6 digit PIN"
              maxLength={6}
              pattern="[0-9]*"
              inputMode="numeric"
            />
          </div>
          <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
            When set, the app will lock after 5 minutes of inactivity. Enter the PIN to unlock.
          </p>
          <button
            className="btn primary"
            disabled={savingSection === 'Security'}
            onClick={() => saveSection('Security', { pin_code: form.pin_code || '' })}
          >
            {savingSection === 'Security' ? 'Saving...' : 'Save Security'}
          </button>
        </div>
      )}

      {activeTab === 'maintenance' && (
        <>
          <div className="settings-card" style={{ marginBottom: 16 }}>
            <h2>Backup & Restore</h2>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn ghost" onClick={async () => {
                const r = await dbBackup();
                if (r.success) addToast(`Backup saved to ${r.path}`, 'success');
                else if (r.reason !== 'canceled') addToast(`Backup failed: ${r.reason}`, 'error');
              }}>Backup Database</button>
              <button className="btn danger" onClick={async () => {
                if (!confirm('Restore will replace all current data. Continue?')) return;
                const r = await dbRestore();
                if (r.success) { addToast('Database restored successfully.', 'success'); if (triggerRefresh) triggerRefresh(); }
                else if (r.reason !== 'canceled') addToast(`Restore failed: ${r.reason}`, 'error');
              }}>Restore Database</button>
            </div>
          </div>
          <div className="settings-card">
            <h2>Reset App</h2>
            <p style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 12 }}>
              Clears local settings, charger state, shifts, logs, transactions, bills and sync queue.
            </p>
            <button className="btn danger" onClick={handleResetApp}>Reset App</button>
          </div>
        </>
      )}
    </>
  );
}

function ShiftRow({ shift, onSave, onDelete }) {
  const [local, setLocal] = useState({ ...shift });

  useEffect(() => {
    setLocal({ ...shift });
  }, [shift]);

  const update = (key, value) => {
    const updated = { ...local, [key]: value };
    setLocal(updated);
  };

  return (
    <div className="shift-row" style={{ marginBottom: 8 }}>
      <div className="form-group">
        <label>Name</label>
        <input value={local.name || ''} onChange={(e) => update('name', e.target.value)} />
      </div>
      <div className="form-group">
        <label>Start</label>
        <input type="time" value={local.start_time || '00:00'} onChange={(e) => update('start_time', e.target.value)} />
      </div>
      <div className="form-group">
        <label>End</label>
        <input type="time" value={local.end_time || '23:59'} onChange={(e) => update('end_time', e.target.value)} />
      </div>
      <div className="form-group">
        <label>Rate/kWh</label>
        <input value={local.rate_per_kwh || ''} onChange={(e) => update('rate_per_kwh', e.target.value)} />
      </div>
      <button className="btn ghost" onClick={() => onSave(local)}>Save</button>
      <div className="form-group">
        <label>Tax %</label>
        <input value={local.tax_percent || '0'} onChange={(e) => update('tax_percent', e.target.value)} />
      </div>
      <button className="btn-del" onClick={() => onDelete(shift.id)} title="Delete shift">×</button>
    </div>
  );
}
