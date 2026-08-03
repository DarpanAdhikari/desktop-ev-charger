import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSettings } from '../hooks/useVoltDesk';
import useKeyboardShortcuts from '../hooks/useKeyboardShortcuts';
import { useContextMenu } from '../hooks/useContextMenu.jsx';
import { listPrinters, testPrinter, dbBackup, dbRestore, resetApp, checkHealth, pickImage, fetchCompanyInfo, bluetoothScan, bluetoothConnect, bluetoothDisconnect, bluetoothList, bluetoothTest, verifyPassword, getSyncStatus, syncNow } from '../services/ipc';
import PinLock from '../components/PinLock';
import FieldTooltip, { ENDPOINT_DOCS } from '../components/FieldTooltip';
import {
  VALIDATION_ERROR, SAVED_SECTION, SAVE_SECTION_FAILED, SHIFT_ADDED,
  COMPANY_INFO_FETCH_FAILED, COMPANY_INFO_UPDATED, FOUND_DEVICES, SCAN_FAILED,
  CONNECT_FAILED, DISCONNECT_FAILED, CONNECTED_TO, DISCONNECTED_LABEL, BT_SCAN_HINT,
  PASSWORD_REQUIRED_PROMPT, PASSWORD_ENTER_PROMPT, PASSWORD_TOO_SHORT, PASSWORD_SAVED_REENTER,
  PASSWORD_REMOVED, REMOVE_PASSWORD_CONFIRM, RESET_CONFIRM, RESET_SCOPE_HELP, RESET_SUCCESS,
  RESET_CANCELED, RESET_FAILED, RESTORE_CONFIRM, RESTORE_SUCCESS, RESTORE_FAILED,
  BACKUP_SAVED, BACKUP_FAILED, BACKUP_DATABASE, RESTORE_DATABASE, RESET_APP,
  SYNC_RUN_COMPLETE, SYNC_FAILED, SYNC_NOW, SYNC_QUEUE_LABEL, SYNCING, REFRESH_LABEL,
  SAVING_LABEL, SAVE_CONNECTION, SAVE_BRANDING, SAVE_RATE_SHIFTS, SAVE_BACKEND_SYNC,
  SAVE_PRINTERS, SAVE_SECURITY, TEST_PAGE_SENT, TEST_FAILED, TEST_PRINT_LABEL, SCANNING_LABEL,
} from '../strings';

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

export default function SettingsPage({ addToast, triggerRefresh, onSecurityChange }) {
  const navigate = useNavigate();
  const { settings, shifts, loading, refresh, saveSettings, saveShift, removeShift } = useSettings();
  const [form, setForm] = useState({});
  const [errors, setErrors] = useState({});
  const [savingSection, setSavingSection] = useState(null);
  const [printers, setPrinters] = useState([]);
  const [btDevices, setBtDevices] = useState([]);
  const [btScanning, setBtScanning] = useState(false);
  const [activeTab, setActiveTab] = useState('connection');
  const [passwordInput, setPasswordInput] = useState('');
  const [gate, setGate] = useState(null);
  const [pageUnlocked, setPageUnlocked] = useState(false);
  const [syncStatus, setSyncStatus] = useState({ pending: 0, failed: 0, sent: 0 });
  const [syncBusy, setSyncBusy] = useState(false);

  const refreshSyncStatus = useCallback(() => {
    getSyncStatus().then(setSyncStatus).catch(() => {});
  }, []);

  useEffect(() => {
    refreshSyncStatus();
  }, [refreshSyncStatus]);

  const runSyncNow = async () => {
    setSyncBusy(true);
    try {
      setSyncStatus(await syncNow());
      addToast(SYNC_RUN_COMPLETE, 'success');
    } catch (e) {
      addToast(SYNC_FAILED(e.message), 'error');
    } finally {
      setSyncBusy(false);
    }
  };

  useEffect(() => {
    listPrinters().then(setPrinters).catch(() => {});
  }, []);

  useEffect(() => {
    if (settings) {
      const { security_password, ...rest } = settings;
      setForm((prev) => ({ ...prev, ...rest }));
    }
  }, [settings]);

  useEffect(() => {
    if (settings && settings.security_password && !pageUnlocked) {
      setGate({ label: 'access Settings', run: null });
    }
  }, [settings, pageUnlocked]);

  const runProtected = (label, action) => {
    if (!settings.security_password) { action(); return; }
    setGate({ label, run: action });
  };

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

  const saveSection = (section, patch, validateFn) => {
    if (validateFn && !validateFn()) {
      addToast(VALIDATION_ERROR, 'error');
      return;
    }
    runProtected(`save ${section}`, async () => {
      setSavingSection(section);
      try {
        await saveSettings(patch);
        addToast(SAVED_SECTION(section), 'success');
        if (triggerRefresh) triggerRefresh();
        if (section === 'Security' && onSecurityChange) onSecurityChange();
      } catch (e) {
        addToast(SAVE_SECTION_FAILED(section, e.message), 'error');
      } finally {
        setSavingSection(null);
      }
    });
  };

  const addShift = () => {
    runProtected('add a shift', () => {
      saveShift({
        name: 'New Shift',
        start_time: '00:00',
        end_time: '23:59',
        rate_per_kwh: '0.10',
        tax_applicable: false,
        tax_percent: '0',
        active: true,
      }).then(() => addToast(SHIFT_ADDED, 'info'));
    });
  };

  const gatedSaveShift = (shift) => runProtected('save a shift', () => saveShift(shift));
  const gatedRemoveShift = (id) => runProtected('delete a shift', () => removeShift(id));

  const saveTab = (tab) => {
    switch (tab) {
      case 'connection':
        saveSection('Connection', {
          ws_url: form.ws_url || '',
          skip_ssl_verify: form.skip_ssl_verify || '0',
        }, validateConnection);
        break;
      case 'branding':
        saveSection('Branding', {
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
        });
        break;
      case 'pricing':
        saveSection('Rate & Shifts', {
          charging_rate_mode: form.charging_rate_mode === 'kw' ? 'kw' : 'percentage',
          default_battery_capacity_kwh: form.default_battery_capacity_kwh || '',
        });
        break;
      case 'printers':
        saveSection('Printers', {
          printer_type: form.printer_type || 'system',
          printer_network_ip: form.printer_network_ip || '',
          printer_network_port: form.printer_network_port || '9100',
          bt_printer_address: form.bt_printer_address || '',
          bt_printer_name: form.bt_printer_name || '',
          thermal_print_mode: form.thermal_print_mode || 'raster',
          bill_format: form.bill_format || 'thermal_80mm',
          print_device_name: form.print_device_name || '',
          paper_width: form.paper_width || '80',
        });
        break;
      case 'backend':
        saveSection('Backend Sync', {
          api_base_url: form.api_base_url || '',
          api_endpoint_bills: form.api_endpoint_bills || '',
          api_endpoint_logs: form.api_endpoint_logs || '',
          api_endpoint_transactions: form.api_endpoint_transactions || '',
          api_health_endpoint: form.api_health_endpoint || '',
          api_key: form.api_key || '',
          api_company_info_endpoint: form.api_company_info_endpoint || '',
          api_bill_format_endpoint: form.api_bill_format_endpoint || '',
          api_customer_search_endpoint: form.api_customer_search_endpoint || '',
        }, validateBackend);
        break;
      case 'security':
        saveSection('Security', {
          ...(passwordInput ? { security_password: passwordInput } : {}),
          auto_lock: form.auto_lock || '1',
          lock_on_startup: form.lock_on_startup || '1',
        });
        break;
      default:
        break;
    }
  };

  const shortcuts = useKeyboardShortcuts(true);
  useEffect(() => {
    shortcuts.register('ctrl+s', () => {
      if (gate) return;
      saveTab(activeTab);
    });
    return () => shortcuts.unregister('ctrl+s');
  }, [shortcuts, activeTab, form, passwordInput, gate]);

  const handleResetApp = async () => {
    if (!settings.security_password) {
      const nextPassword = window.prompt(PASSWORD_REQUIRED_PROMPT);
      if (!nextPassword) return;
      if (nextPassword.length < 4) {
        addToast(PASSWORD_TOO_SHORT, 'error');
        return;
      }
      await saveSettings({ security_password: nextPassword });
      addToast(PASSWORD_SAVED_REENTER, 'info');
    }

    const enteredPassword = window.prompt(PASSWORD_ENTER_PROMPT);
    if (!enteredPassword) return;
    if (!window.confirm(RESET_CONFIRM)) return;

    const result = await resetApp({ pin: enteredPassword });
    if (!result.success) {
      addToast(result.reason === 'invalid_pin' || result.reason === 'pin_not_configured' ? RESET_CANCELED : RESET_FAILED(result.reason), 'error');
      return;
    }
    addToast(RESET_SUCCESS, 'success');
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
            onClick={() => saveTab('connection')}
          >
            {savingSection === 'Connection' ? SAVING_LABEL : SAVE_CONNECTION}
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
                    if (!info) { addToast(COMPANY_INFO_FETCH_FAILED, 'error'); return; }
                    if (info.company_name) updateField('company_name', info.company_name);
                    if (info.company_address) updateField('company_address', info.company_address);
                    if (info.company_phone) updateField('company_phone', info.company_phone);
                    if (info.company_email) updateField('company_email', info.company_email);
                    if (info.bill_prefix) updateField('bill_prefix', info.bill_prefix);
                    if (info.branding_logo) updateField('branding_logo', info.branding_logo);
                    if (info.invoice_logo) updateField('invoice_logo', info.invoice_logo);
                    addToast(COMPANY_INFO_UPDATED, 'success');
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
            onClick={() => saveTab('branding')}
          >
            {savingSection === 'Branding' ? SAVING_LABEL : SAVE_BRANDING}
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
            <ShiftRow key={shift.id} shift={shift} onSave={gatedSaveShift} onDelete={gatedRemoveShift} />
          ))}
          <button className="btn ghost" onClick={addShift} style={{ marginTop: 8 }}>+ Add shift</button>
          <div style={{ marginTop: 20 }}>
            <button
              className="btn primary"
              disabled={savingSection === 'Rate & Shifts'}
              onClick={() => saveTab('pricing')}
            >
              {savingSection === 'Rate & Shifts' ? SAVING_LABEL : SAVE_RATE_SHIFTS}
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
          <div style={{ display: 'flex', gap: 12 }}>
            <div className="form-group" style={{ flex: 2 }}>
              <label>Login Endpoint <FieldTooltip endpointKey="api_login_endpoint" /></label>
              <input value={form.api_login_endpoint || ''} onChange={(e) => updateField('api_login_endpoint', e.target.value)} placeholder="/api/login" />
            </div>
            <div className="form-group" style={{ flex: 1 }}>
              <label>Username</label>
              <input value={form.api_username || ''} onChange={(e) => updateField('api_username', e.target.value)} />
            </div>
            <div className="form-group" style={{ flex: 1 }}>
              <label>Password</label>
              <input type="password" value={form.api_password || ''} onChange={(e) => updateField('api_password', e.target.value)} />
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
            { key: 'api_bill_details_endpoint', placeholder: '/api/bill/details' },
            { key: 'api_bill_number_endpoint', placeholder: '/api/bill/next-number' },
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
          <hr style={{ border: 'none', borderTop: '1px solid #333', margin: '16px 0' }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12, fontWeight: 600 }}>{SYNC_QUEUE_LABEL}</span>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              <span style={{ color: 'var(--amber)', fontWeight: 600 }}>{syncStatus.pending}</span> pending
              {' · '}
              <span style={{ color: 'var(--danger, #e5484d)', fontWeight: 600 }}>{syncStatus.failed}</span> failed
              {' · '}
              <span style={{ color: 'var(--teal)', fontWeight: 600 }}>{syncStatus.sent}</span> sent
            </span>
            <button className="btn ghost" style={{ padding: '6px 12px', fontSize: 11 }} onClick={refreshSyncStatus}>{REFRESH_LABEL}</button>
            <button className="btn ghost" style={{ padding: '6px 12px', fontSize: 11 }} onClick={runSyncNow} disabled={syncBusy}>
              {syncBusy ? SYNCING : SYNC_NOW}
            </button>
          </div>
          <button
            className="btn primary"
            disabled={savingSection === 'Backend Sync'}
            onClick={() => saveTab('backend')}
          >
            {savingSection === 'Backend Sync' ? SAVING_LABEL : SAVE_BACKEND_SYNC}
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
                      addToast(FOUND_DEVICES((devices || []).length), 'success');
                    } catch (e) {
                      addToast(SCAN_FAILED(e.message), 'error');
                    } finally {
                      setBtScanning(false);
                    }
                  }}
                >{btScanning ? SCANNING_LABEL : '🔍 Scan'}</button>
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
                                addToast(DISCONNECTED_LABEL, 'success');
                              } catch (e) {
                                addToast(DISCONNECT_FAILED(e.message), 'error');
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
                                addToast(CONNECTED_TO(d.name || d.address), 'success');
                              } catch (e) {
                                addToast(CONNECT_FAILED(e.message), 'error');
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
                <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }} dangerouslySetInnerHTML={{ __html: BT_SCAN_HINT }} />
              )}
            </div>
          )}

          <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
            <button
              className="btn primary"
              disabled={savingSection === 'Printers'}
              onClick={() => saveTab('printers')}
            >
              {savingSection === 'Printers' ? SAVING_LABEL : SAVE_PRINTERS}
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
                if (result.success) addToast(TEST_PAGE_SENT, 'success');
                else addToast(TEST_FAILED(result), 'error');
              }}
            >{TEST_PRINT_LABEL}</button>
          </div>
        </div>
      )}

      {activeTab === 'security' && (
        <div className="settings-card">
          <h2>Security</h2>
          <div className="form-group">
            <label>Security Password</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                type="password"
                value={passwordInput}
                onChange={(e) => setPasswordInput(e.target.value)}
                placeholder={settings.security_password ? 'Leave blank to keep current password' : 'Minimum 4 characters'}
                maxLength={64}
                autoComplete="new-password"
                style={{ flex: 1 }}
              />
              {settings.security_password && (
                <button
                  className="btn ghost"
                  style={{ whiteSpace: 'nowrap' }}
                  onClick={() => {
                    if (!window.confirm(REMOVE_PASSWORD_CONFIRM)) return;
                    runProtected('remove the password', async () => {
                      await saveSettings({ security_password: '' });
                      setPasswordInput('');
                      addToast(PASSWORD_REMOVED, 'success');
                      if (onSecurityChange) onSecurityChange();
                    });
                  }}
                >Remove</button>
              )}
            </div>
          </div>
          <div className="form-group" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <label className="toggle-switch">
              <input
                type="checkbox"
                id="auto_lock"
                checked={form.auto_lock !== '0'}
                onChange={(e) => updateField('auto_lock', e.target.checked ? '1' : '0')}
              />
              <span className="toggle-slider"></span>
            </label>
            <label htmlFor="auto_lock" style={{ margin: 0, cursor: 'pointer' }}>
              Lock the app after 5 minutes of inactivity
            </label>
          </div>
          <div className="form-group" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <label className="toggle-switch">
              <input
                type="checkbox"
                id="lock_on_startup"
                checked={form.lock_on_startup !== '0'}
                onChange={(e) => updateField('lock_on_startup', e.target.checked ? '1' : '0')}
              />
              <span className="toggle-slider"></span>
            </label>
            <label htmlFor="lock_on_startup" style={{ margin: 0, cursor: 'pointer' }}>
              Lock the app on startup
            </label>
          </div>
          <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
            Default password is "admin". When a password is set, opening Settings and saving any setting requires the password.
          </p>
          <button
            className="btn primary"
            disabled={savingSection === 'Security'}
            onClick={() => saveTab('security')}
          >
            {savingSection === 'Security' ? SAVING_LABEL : SAVE_SECURITY}
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
                if (r.success) addToast(BACKUP_SAVED(r.path), 'success');
                else if (r.reason !== 'canceled') addToast(BACKUP_FAILED(r.reason), 'error');
              }}>{BACKUP_DATABASE}</button>
              <button className="btn danger" onClick={async () => {
                if (!confirm(RESTORE_CONFIRM)) return;
                runProtected('restore the database', async () => {
                  const r = await dbRestore();
                  if (r.success) { addToast(RESTORE_SUCCESS, 'success'); if (triggerRefresh) triggerRefresh(); }
                  else if (r.reason !== 'canceled') addToast(RESTORE_FAILED(r.reason), 'error');
                });
              }}>{RESTORE_DATABASE}</button>
            </div>
          </div>
          <div className="settings-card">
            <h2>{RESET_APP}</h2>
            <p style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 12 }}>
              {RESET_SCOPE_HELP}
            </p>
            <button className="btn danger" onClick={handleResetApp}>{RESET_APP}</button>
          </div>
        </>
      )}

      {gate && (
        <PinLock
          onSubmit={async (value) => {
            const res = await verifyPassword(value);
            if (res && res.ok) {
              const { run } = gate;
              const isPageGate = !run;
              setGate(null);
              if (isPageGate) setPageUnlocked(true);
              else run();
              return true;
            }
            return false;
          }}
          onCancel={gate.run ? () => setGate(null) : () => navigate('/')}
          prompt={`Enter password to ${gate.label}`}
          buttonLabel={gate.run ? 'Confirm' : 'Unlock'}
        />
      )}
    </>
  );
}

function ShiftRow({ shift, onSave, onDelete }) {
  const { openMenu } = useContextMenu();
  const [local, setLocal] = useState({ ...shift });

  useEffect(() => {
    setLocal({ ...shift });
  }, [shift]);

  const update = (key, value) => {
    const updated = { ...local, [key]: value };
    setLocal(updated);
  };

  const handleContextMenu = (e) => {
    openMenu(e, [
      { label: 'Save shift', run: () => onSave(local) },
      { label: 'Delete shift', danger: true, run: () => onDelete(shift.id) },
    ]);
  };

  return (
    <div className="shift-row" style={{ marginBottom: 8 }} onContextMenu={handleContextMenu}>
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
