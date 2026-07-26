import { useState, useEffect, useCallback } from 'react';
import { useSettings } from '../hooks/useVoltDesk';
import { listPrinters, dbBackup, dbRestore, resetApp, checkHealth } from '../services/ipc';
import FieldTooltip from '../components/FieldTooltip';

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
    return <div className="empty-state"><p>Loading settings...</p></div>;
  }

  return (
    <>
      <header className="view-header">
        <h1>Settings</h1>
        <p className="muted">Connection, shifts, tax, branding and sync.</p>
      </header>

      <div className="settings-grid">
        {/* Connection */}
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
            <input
              type="checkbox"
              id="skip_ssl"
              checked={form.skip_ssl_verify === '1'}
              onChange={(e) => updateField('skip_ssl_verify', e.target.checked ? '1' : '0')}
              style={{ width: 'auto', accentColor: 'var(--amber)' }}
            />
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

        {/* Branding */}
        <div className="settings-card">
          <h2>Branding & Invoice</h2>
          <div className="form-group">
            <label>Company Name</label>
            <input value={form.company_name || ''} onChange={(e) => updateField('company_name', e.target.value)} />
          </div>
          <div className="form-group">
            <label>Bill Number Prefix</label>
            <input value={form.bill_prefix || 'INV'} onChange={(e) => updateField('bill_prefix', e.target.value)} />
          </div>
          <div className="form-group">
            <label>Print Format</label>
            <select value={form.bill_format || 'thermal_80mm'} onChange={(e) => updateField('bill_format', e.target.value)}>
              <option value="thermal_80mm">Thermal 80mm</option>
              <option value="a4">A4</option>
            </select>
          </div>
          <div className="form-group">
            <label>Printer</label>
            <select value={form.print_device_name || ''} onChange={(e) => updateField('print_device_name', e.target.value)}>
              <option value="">— Default printer —</option>
              {printers.map((p) => (
                <option key={p.name} value={p.name}>{p.displayName || p.name}</option>
              ))}
            </select>
          </div>
          <button
            className="btn primary"
            disabled={savingSection === 'Branding'}
            onClick={() => saveSection('Branding', {
              company_name: form.company_name || '',
              bill_prefix: form.bill_prefix || 'INV',
              bill_format: form.bill_format || 'thermal_80mm',
              print_device_name: form.print_device_name || '',
            })}
          >
            {savingSection === 'Branding' ? 'Saving...' : 'Save Branding'}
          </button>
        </div>

        {/* Backend Sync */}
        <div className="settings-card full">
          <h2>Backend Sync</h2>
          <div className="form-group">
            <label>API Base URL</label>
            <input
              value={form.api_base_url || ''}
              onChange={(e) => updateField('api_base_url', e.target.value)}
              placeholder="https://your-server.com"
            />
            {errors.api_base_url && <div className="field-error">{errors.api_base_url}</div>}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 12 }}>
            <div className="form-group">
              <label>Bills Endpoint<FieldTooltip endpointKey="api_endpoint_bills" /></label>
              <input value={form.api_endpoint_bills || ''} onChange={(e) => updateField('api_endpoint_bills', e.target.value)} placeholder="/api/bills" />
            </div>
            <div className="form-group">
              <label>Logs Endpoint<FieldTooltip endpointKey="api_endpoint_logs" /></label>
              <input value={form.api_endpoint_logs || ''} onChange={(e) => updateField('api_endpoint_logs', e.target.value)} placeholder="/api/logs" />
            </div>
            <div className="form-group">
              <label>Transactions Endpoint<FieldTooltip endpointKey="api_endpoint_transactions" /></label>
              <input value={form.api_endpoint_transactions || ''} onChange={(e) => updateField('api_endpoint_transactions', e.target.value)} placeholder="/api/transactions" />
            </div>
            <div className="form-group">
              <label>Health Endpoint<FieldTooltip endpointKey="api_health_endpoint" /></label>
              <div style={{ display: 'flex', gap: 4 }}>
                <input value={form.api_health_endpoint || ''} onChange={(e) => updateField('api_health_endpoint', e.target.value)} placeholder="/api/health" style={{ flex: 1 }} />
                <button className="btn ghost" style={{ padding: '6px 12px', fontSize: 11, whiteSpace: 'nowrap' }}
                  onClick={async () => {
                    const r = await checkHealth();
                    if (r.ok) addToast(`API health: ${r.status} (${r.latency}ms)`, 'success');
                    else if (r.reason === 'not_configured') addToast('API Base URL not configured', 'error');
                    else addToast(`API health failed: ${r.reason} (${r.latency}ms)`, 'error');
                  }}
                >Test</button>
              </div>
            </div>
          </div>
          <div className="form-group">
            <label>API Key</label>
            <input type="password" value={form.api_key || ''} onChange={(e) => updateField('api_key', e.target.value)} />
          </div>
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
            }, validateBackend)}
          >
            {savingSection === 'Backend Sync' ? 'Saving...' : 'Save Backend Sync'}
          </button>
        </div>

        {/* Charging Rate */}
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
          <button
            className="btn primary"
            disabled={savingSection === 'Charging Rate'}
            onClick={() => saveSection('Charging Rate', {
              charging_rate_mode: form.charging_rate_mode === 'kw' ? 'kw' : 'percentage',
              default_battery_capacity_kwh: form.default_battery_capacity_kwh || '',
            })}
          >
            {savingSection === 'Charging Rate' ? 'Saving...' : 'Save Charging Rate'}
          </button>
        </div>

        {/* Shifts & Tax */}
        <div className="settings-card full">
          <h2>Shifts & Tax</h2>
          {shifts.map((shift) => (
            <ShiftRow key={shift.id} shift={shift} onSave={saveShift} onDelete={removeShift} />
          ))}
          <button className="btn ghost" onClick={addShift} style={{ marginTop: 8 }}>+ Add shift</button>
        </div>

        {/* Security */}
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

        {/* Backup & Restore */}
        <div className="settings-card">
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

        {/* Reset */}
        <div className="settings-card">
          <h2>Reset App</h2>
          <p style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 12 }}>
            Clears local settings, charger state, shifts, logs, transactions, bills and sync queue.
          </p>
          <button className="btn danger" onClick={handleResetApp}>Reset App</button>
        </div>

      </div>
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
