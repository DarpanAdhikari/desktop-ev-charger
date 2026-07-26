import { useState, useCallback, useEffect, useRef } from 'react';
import { HashRouter, Routes, Route, NavLink } from 'react-router-dom';
import { useConnectionStatus, useToast } from './hooks/useVoltDesk';
import { getSettings, setSettings } from './services/ipc';
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

function Shell() {
  const { connected, connecting, url, error: wsError, health } = useConnectionStatus();
  const { toasts, addToast } = useToast();
  const [refreshKey, setRefreshKey] = useState(0);
  const [locked, setLocked] = useState(false);
  const [pinCode, setPinCode] = useState(null);
  const [theme, setTheme] = useState('dark');
  const inactivityRef = useRef(null);

  useEffect(() => {
    getSettings().then((s) => {
      setPinCode(s.pin_code || '');
      setTheme(s.theme || 'dark');
      if (s.pin_code) setLocked(true);
    });
  }, []);

  useEffect(() => {
    document.documentElement.className = theme === 'light' ? 'theme-light' : '';
  }, [theme]);

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
      <nav className="sidebar">
        <div className="brand">
          <img className="brand-logo" src={logoUrl} alt="DRP logo" />
          <div className="brand-copy">
            <div className="brand-name">DRP</div>
            <div className="brand-subtitle">Dynamic Recharge Platform</div>
          </div>
        </div>
        <NavLink className="nav-item" to="/">
          <span className="nav-dot"></span>Dashboard
        </NavLink>
        <NavLink className="nav-item" to="/chargers">
          <span className="nav-dot"></span>Chargers
        </NavLink>
        <NavLink className="nav-item" to="/billing">
          <span className="nav-dot"></span>Billing
        </NavLink>
        <NavLink className="nav-item" to="/transactions">
          <span className="nav-dot"></span>Transactions
        </NavLink>
        <NavLink className="nav-item" to="/logs">
          <span className="nav-dot"></span>Logs
        </NavLink>
        <NavLink className="nav-item" to="/settings">
          <span className="nav-dot"></span>Settings
        </NavLink>
        <div style={{ padding: '8px 20px', borderTop: '1px solid var(--border)' }}>
          <button
            onClick={toggleTheme}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              color: 'var(--text-muted)', fontSize: 18, padding: '4px 0',
              display: 'flex', alignItems: 'center', gap: 8, width: '100%',
              fontFamily: "'Inter', sans-serif", fontSize: 12,
            }}
            title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
          >
            {theme === 'dark' ? '☀️' : '🌙'}
            <span style={{ color: 'var(--text-muted)' }}>
              {theme === 'dark' ? 'Light mode' : 'Dark mode'}
            </span>
          </button>
        </div>
        <div className="conn-status">
          <span className={`conn-led ${ledClass}`}></span>
          <span id="connLabel">{label}</span>
        </div>
        {healthLabel && (
          <div style={{
            padding: '0 20px 10px', fontSize: 10, color: healthOk ? 'var(--teal)' : 'var(--red)',
            fontFamily: "'JetBrains Mono', monospace", display: 'flex', alignItems: 'center', gap: 4,
          }}>
            <span style={{ width: 5, height: 5, borderRadius: '50%', background: healthOk ? 'var(--teal)' : 'var(--red)', display: 'inline-block' }}></span>
            {healthLabel}
          </div>
        )}
      </nav>

      <main className="content">
        <Routes>
          <Route path="/" element={<DashboardPage refreshKey={refreshKey} addToast={addToast} />} />
          <Route path="/chargers" element={<ChargersPage refreshKey={refreshKey} addToast={addToast} />} />
          <Route path="/chargers/:id" element={<ChargerDetailPage refreshKey={refreshKey} addToast={addToast} />} />
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
      {pinCode && locked && <PinLock onUnlock={handleUnlock} />}
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
