import { useState, useCallback, useEffect, useRef } from 'react';
import { HashRouter, Routes, Route, NavLink, useLocation } from 'react-router-dom';
import { useConnectionStatus, useToast, useLiveEvents } from './hooks/useVoltDesk';
import { getSettings, setSettings, listChargers, listBills, fetchCompanyInfo } from './services/ipc';
import ChargersPage from './pages/ChargersPage';
import ChargerDetailPage from './pages/ChargerDetailPage';
import BillingPage from './pages/BillingPage';
import TransactionsPage from './pages/TransactionsPage';
import LogsPage from './pages/LogsPage';
import SettingsPage from './pages/SettingsPage';
import DashboardPage from './pages/DashboardPage';
import ToastContainer from './components/ToastContainer';
import PinLock from './components/PinLock';
import logoUrl from '../../assets/logo/logo.png';

const INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000;

const NAV_ITEMS = [
  { to: '/', label: 'Dashboard', icon: 'M2 3h6v6H2V3zm10 0h6v4h-6V3zm0 6h6v8h-6V9zM2 11h6v8H2v-8z' },
  { to: '/chargers', label: 'Chargers', icon: 'M4 2h12a1 1 0 011 1v14a1 1 0 01-1 1H4a1 1 0 01-1-1V3a1 1 0 011-1zm0 3h12M4 8h12M4 11h12M4 14h8' },
  { to: '/billing', label: 'Billing', icon: 'M3 3h14v14H3V3zm2 4h10M5 10h10M5 13h6' },
  { to: '/transactions', label: 'Transactions', icon: 'M12 4l-4 4h3v8h2V8h3l-4-4zM6 12l4 4H7v8H5v-8H2l4-4z' },
  { to: '/logs', label: 'Logs', icon: 'M4 3h12a1 1 0 011 1v12a1 1 0 01-1 1H4a1 1 0 01-1-1V4a1 1 0 011-1zm1 3h10M5 9h10M5 12h6' },
  { to: '/settings', label: 'Settings', icon: 'M10 13a3 3 0 100-6 3 3 0 000 6zm7.5-2.5h-1.2a5.5 5.5 0 00-.5-1.2l.9-.9a.8.8 0 000-1.1l-1-1a.8.8 0 00-1.1 0l-.9.9a5.5 5.5 0 00-1.2-.5V5.5a.8.8 0 00-.8-.8h-1.4a.8.8 0 00-.8.8v1.2a5.5 5.5 0 00-1.2.5l-.9-.9a.8.8 0 00-1.1 0l-1 1a.8.8 0 000 1.1l.9.9a5.5 5.5 0 00-.5 1.2H5.5a.8.8 0 00-.8.8v1.4a.8.8 0 00.8.8h1.2a5.5 5.5 0 00.5 1.2l-.9.9a.8.8 0 000 1.1l1 1a.8.8 0 001.1 0l.9-.9a5.5 5.5 0 001.2.5v1.2a.8.8 0 00.8.8h1.4a.8.8 0 00.8-.8v-1.2a5.5 5.5 0 001.2-.5l.9.9a.8.8 0 001.1 0l1-1a.8.8 0 000-1.1l-.9-.9a5.5 5.5 0 00.5-1.2h1.2a.8.8 0 00.8-.8v-1.4a.8.8 0 00-.8-.8z' },
];

function NavSvgIcon({ path }) {
  return (
    <svg className="nav-icon" viewBox="0 0 20 20" fill="currentColor" width="18" height="18">
      <path d={path} />
    </svg>
  );
}

function Shell() {
  const location = useLocation();
  const { connected, connecting, url, error: wsError, health } = useConnectionStatus();
  const { toasts, addToast } = useToast();
  const [chargerAlerts, setChargerAlerts] = useState({});
  const [offlineConnectors, setOfflineConnectors] = useState({});
  const lastSeen = useRef({});
  const [refreshKey, setRefreshKey] = useState(0);

  useLiveEvents({
    onChargerEvent: (evt) => {
      if (evt.charger_id) {
        lastSeen.current['c:' + evt.charger_id] = Date.now();
      }
      if (evt.connector_id != null) {
        const key = `${evt.charger_id}:${evt.connector_id}`;
        lastSeen.current[key] = Date.now();
        setOfflineConnectors((prev) => {
          if (!prev[key]) return prev;
          const next = { ...prev };
          delete next[key];
          return next;
        });
      }
      if (evt.type === 'charger_status') {
        setChargerAlerts((prev) => ({ ...prev, [evt.charger_id]: { status: evt.status, error: evt.error, ts: Date.now() } }));
      }
      if (evt.type === 'charge_complete') {
        addToast(`Charger ${evt.charger_id} connector ${evt.connector_id} finished charging`, 'success');
      }
      if (evt.type === 'fault_alert') {
        addToast(`Charger ${evt.charger_id} fault${evt.error ? ': ' + evt.error : ''}`, 'error');
      }
      if (evt.type === 'command_result') {
        if (evt.status === 'rejected') {
          addToast(`${evt.command} rejected: ${evt.reason}`, 'error');
        } else {
          addToast(`${evt.command} command sent successfully`, 'success');
        }
      }
    },
    onBillingEvent: (evt) => {
      if (evt.type === 'bill_generated' && evt.bill) {
        addToast(`Bill #${evt.bill.bill_number || evt.bill.id} generated`, 'success');
      }
      if (evt.type === 'bill_error') {
        addToast(`Bill generation failed: ${evt.error}`, 'error');
      }
    }
  });

  useEffect(() => {
    let mounted = true;
    const tick = async () => {
      const now = Date.now();
      const stale = {};
      for (const [key, ts] of Object.entries(lastSeen.current)) {
        if (now - ts > 60000) stale[key] = ts;
      }
      try {
        const chargersData = await listChargers();
        if (!mounted) return;
        for (const ch of chargersData) {
          const chargerSeen = lastSeen.current['c:' + ch.id];
          for (const con of (ch.connectors || [])) {
            const key = `${ch.id}:${con.connector_id}`;
            const ts = lastSeen.current[key];
            if (!ts && (!chargerSeen || now - chargerSeen > 60000)) {
              stale[key] = chargerSeen || (now - 60001);
            }
          }
        }
      } catch (e) { /* ignore */ }
      setOfflineConnectors((prev) => {
        const next = { ...prev };
        for (const key of Object.keys(stale)) next[key] = stale[key];
        for (const key of Object.keys(next)) {
          if (!stale[key] && !lastSeen.current[key]) delete next[key];
        }
        return next;
      });
    };
    tick();
    const interval = setInterval(tick, 30000);
    return () => { mounted = false; clearInterval(interval); };
  }, []);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [chargerCount, setChargerCount] = useState({ online: 0, total: 0 });
  const [pendingBills, setPendingBills] = useState(0);
  const [brandingLogo, setBrandingLogo] = useState(null);
  const [locked, setLocked] = useState(false);
  const [pinCode, setPinCode] = useState(null);
  const [theme, setTheme] = useState('dark');
  const inactivityRef = useRef(null);

  useEffect(() => {
    getSettings().then((s) => {
      setPinCode(s.pin_code || '');
      setTheme(s.theme || 'dark');
      if (s.branding_logo) setBrandingLogo(s.branding_logo);
      if (s.pin_code) setLocked(true);
    });
  }, []);

  useEffect(() => {
    document.documentElement.className = theme === 'light' ? 'theme-light' : '';
  }, [theme]);

  useEffect(() => {
    let mounted = true;
    const fetch = async () => {
      try {
        const chargers = await listChargers();
        if (mounted) {
          const online = chargers.filter((c) => c.online).length;
          setChargerCount({ online, total: chargers.length });
        }
      } catch {}
    };
    fetch();
    const interval = setInterval(fetch, 15000);
    return () => { mounted = false; clearInterval(interval); };
  }, [refreshKey]);

  useEffect(() => {
    let mounted = true;
    const fetch = async () => {
      try {
        const bills = await listBills({ limit: 9999 });
        if (mounted) setPendingBills(bills.filter((b) => b.status === 'pending' || !b.printed_at).length);
      } catch {}
    };
    fetch();
    const interval = setInterval(fetch, 30000);
    return () => { mounted = false; clearInterval(interval); };
  }, [refreshKey]);

  const toggleTheme = async () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    await setSettings({ theme: next });
  };

  const resetInactivityTimer = useCallback(() => {
    if (!pinCode) return;
    clearTimeout(inactivityRef.current);
    inactivityRef.current = setTimeout(() => setLocked(true), INACTIVITY_TIMEOUT_MS);
  }, [pinCode]);

  useEffect(() => {
    if (!pinCode) return;
    const events = ['mousedown', 'keydown', 'mousemove', 'touchstart', 'scroll'];
    const handler = () => resetInactivityTimer();
    events.forEach((e) => window.addEventListener(e, handler));
    resetInactivityTimer();
    return () => {
      clearTimeout(inactivityRef.current);
      events.forEach((e) => window.removeEventListener(e, handler));
    };
  }, [pinCode, resetInactivityTimer]);

  const handleUnlock = async (value) => {
    const s = await getSettings();
    if (value === s.pin_code) {
      setLocked(false);
      resetInactivityTimer();
      return true;
    }
    return false;
  };

  const triggerRefresh = useCallback(() => {
    setRefreshKey((k) => k + 1);
  }, []);

  let ledClass = 'reconnecting';
  let label = 'Disconnected';
  if (connecting) { ledClass = 'reconnecting'; label = 'Connecting...'; }
  else if (connected) { ledClass = 'connected'; label = url || 'Connected'; }
  else if (wsError) { ledClass = 'reconnecting'; label = wsError; }

  const healthOk = health && health.ok;
  const healthLabel = health
    ? healthOk
      ? `API ${health.status} (${health.latency}ms)`
      : `API ${health.reason || 'unreachable'}`
    : null;

  const content = (
    <div className="shell" onClick={resetInactivityTimer} onMouseMove={resetInactivityTimer} onKeyDown={resetInactivityTimer}>
      <nav className={`sidebar${sidebarCollapsed ? ' collapsed' : ''}`}>
        <div className="brand">
          <img className="brand-logo" src={brandingLogo || logoUrl} alt="DRP logo" />
          <div className="brand-copy">
            <div className="brand-name">DRP</div>
            <div className="brand-subtitle">Dynamic Recharge Platform</div>
          </div>
        </div>
        <button
          className="sidebar-collapse-btn"
          onClick={() => setSidebarCollapsed((c) => !c)}
          title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {sidebarCollapsed ? '\u25B6' : '\u25C0'}
        </button>
        {NAV_ITEMS.map((item) => (
          <NavLink key={item.to} className="nav-item" to={item.to} end={item.to === '/'}>
            <NavSvgIcon path={item.icon} />
            <span className="nav-label">{item.label}</span>
            {item.to === '/chargers' && chargerCount.total > 0 && (
              <span className="nav-badge">{chargerCount.online}/{chargerCount.total}</span>
            )}
            {item.to === '/billing' && pendingBills > 0 && (
              <span className="nav-badge">{pendingBills}</span>
            )}
          </NavLink>
        ))}
        <div className="sidebar-theme">
          <button onClick={toggleTheme} title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}>
            {theme === 'dark' ? '\u2600\uFE0F' : '\uD83C\uDF19'}
            <span className="nav-label">{theme === 'dark' ? 'Light mode' : 'Dark mode'}</span>
          </button>
        </div>
        <div className="conn-status">
          <span className={`conn-led ${ledClass}`}></span>
          <span className="conn-label" id="connLabel">{label}</span>
        </div>
        {healthLabel && (
          <div className={`sidebar-health ${healthOk ? 'ok' : 'fail'}`}>
            <span className="sidebar-health-dot"></span>
            <span className="nav-label">{healthLabel}</span>
          </div>
        )}
        {Object.entries(chargerAlerts).map(([cid, alert]) => {
          const s = (alert.status || '').toLowerCase();
          if (s === 'available') return null;
          return (
            <div key={cid} className={`sidebar-alert ${s === 'faulted' ? 'fault' : 'warn'}`}>
              <span className="sidebar-alert-dot"></span>
              <span className="nav-label">{cid}: {alert.status}{alert.error ? ` - ${alert.error}` : ''}</span>
            </div>
          );
        })}
        {Object.entries(offlineConnectors).length > 0 && (
          <div className="sidebar-offline">
            <span className="nav-label">{Object.keys(offlineConnectors).length} connector(s) offline</span>
          </div>
        )}
      </nav>

      <main className="content" key={location.pathname}>
        <Routes>
          <Route path="/" element={<DashboardPage refreshKey={refreshKey} addToast={addToast} offlineConnectors={offlineConnectors} />} />
          <Route path="/chargers" element={<ChargersPage refreshKey={refreshKey} addToast={addToast} offlineConnectors={offlineConnectors} />} />
          <Route path="/chargers/:id" element={<ChargerDetailPage refreshKey={refreshKey} addToast={addToast} offlineConnectors={offlineConnectors} />} />
          <Route path="/billing" element={<BillingPage refreshKey={refreshKey} addToast={addToast} />} />
          <Route path="/transactions" element={<TransactionsPage refreshKey={refreshKey} addToast={addToast} />} />
          <Route path="/logs" element={<LogsPage refreshKey={refreshKey} addToast={addToast} />} />
          <Route path="/settings" element={<SettingsPage refreshKey={refreshKey} addToast={addToast} triggerRefresh={triggerRefresh} />} />
        </Routes>
      </main>

      <ToastContainer toasts={toasts} />
    </div>
  );

  return (
    <>
      {pinCode && locked && <PinLock onUnlock={handleUnlock} brandingLogo={brandingLogo} />}
      {content}
    </>
  );
}

export default function App() {
  return (
    <HashRouter>
      <Shell />
    </HashRouter>
  );
}
