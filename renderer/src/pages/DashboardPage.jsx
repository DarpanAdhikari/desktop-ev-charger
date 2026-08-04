import { useState, useEffect } from 'react';
import { useChargers, useBills, useLiveEvents } from '../hooks/useVoltDesk';
import { transactionsDaily, listTransactions } from '../services/ipc';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import ChargerStatusCard from '../components/ChargerStatusCard';
import { EMPTY_ENERGY_CHART, EMPTY_RECENT_SESSIONS } from '../strings';
import { DASHBOARD_DAYS, RECENT_SESSIONS_LIMIT, DATA_REFRESH_MS } from '../constants';

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

export default function DashboardPage({ addToast, offlineConnectors }) {
  const { chargers, loading, refresh } = useChargers();
  const { bills } = useBills();
  const [dailyData, setDailyData] = useState([]);
  const [recentSessions, setRecentSessions] = useState([]);

  useLiveEvents({ onChargerEvent: () => refresh() });

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const from = daysAgo(DASHBOARD_DAYS);
        const daily = await transactionsDaily({ fromDate: from });
        if (mounted) setDailyData((daily || []).map((d) => ({
          day: d.day ? d.day.slice(5) : '?',
          sessions: d.count || 0,
          energy: d.energy || 0,
        })));
      } catch {}
    })();
    (async () => {
      try {
        const txs = await listTransactions({ limit: RECENT_SESSIONS_LIMIT });
        if (mounted) setRecentSessions(
          (txs || [])
            .filter((t) => t.status === 'stopped' || t.stopped_at)
            .slice(0, 8)
        );
      } catch {}
    })();
    const interval = setInterval(async () => {
      try {
        const from = daysAgo(DASHBOARD_DAYS);
        const daily = await transactionsDaily({ fromDate: from });
        if (mounted) setDailyData((daily || []).map((d) => ({
          day: d.day ? d.day.slice(5) : '?',
          sessions: d.count || 0,
          energy: d.energy || 0,
        })));
        const txs = await listTransactions({ limit: RECENT_SESSIONS_LIMIT });
        if (mounted) setRecentSessions(
          (txs || [])
            .filter((t) => t.status === 'stopped' || t.stopped_at)
            .slice(0, 8)
        );
      } catch {}
    }, DATA_REFRESH_MS);
    return () => { mounted = false; clearInterval(interval); };
  }, []);

  if (loading) {
    return (
      <>
        <header className="view-header">
          <h1>Dashboard</h1>
          <p className="muted">Loading your charging network...</p>
        </header>
        <div className="dash-stats">
          {[1,2,3,4,5,6].map((i) => (
            <div key={i} className="dash-stat" style={{ opacity: 0.5 }}>
              <div className="dash-stat-icon" style={{ width: 32, height: 32, background: 'var(--bg-raised)', borderRadius: 8 }} />
              <div className="dash-stat-body" style={{ flex: 1 }}>
                <div className="dash-stat-label" style={{ height: 10, width: '60%', background: 'var(--bg-raised)', borderRadius: 4, marginBottom: 4 }} />
                <div className="dash-stat-value" style={{ height: 16, width: '40%', background: 'var(--bg-raised)', borderRadius: 4 }} />
              </div>
            </div>
          ))}
        </div>
      </>
    );
  }

  const online = chargers.filter((c) => c.online).length;
  const offline = chargers.filter((c) => !c.online).length;
  const activeSessions = chargers.reduce(
    (sum, c) => sum + (c.active_transactions ? c.active_transactions.length : 0), 0
  );
  const chargingNow = chargers.filter((c) =>
    (c.connectors || []).some((con) => (con.status || '').toLowerCase() === 'charging')
  ).length;
  const billList = Array.isArray(bills) ? bills : [];
  const totalEnergy = billList.reduce((sum, b) => sum + Number(b.energy_kwh || 0), 0);
  const totalRevenue = billList.reduce((sum, b) => sum + Number(b.total || 0), 0);
  const todayBills = billList.filter((b) => b.created_at && new Date(b.created_at).toDateString() === new Date().toDateString());
  const todayRevenue = todayBills.reduce((sum, b) => sum + Number(b.total || 0), 0);
  const todayEnergy = todayBills.reduce((sum, b) => sum + Number(b.energy_kwh || 0), 0);

  const dailyList = Array.isArray(dailyData) ? dailyData : [];
  const totalSessions7d = dailyList.reduce((s, d) => s + Number(d.sessions || 0), 0);
  const energy7d = dailyList.reduce((s, d) => s + Number(d.energy || 0), 0);

  return (
    <>
      <header className="view-header">
        <h1>Dashboard</h1>
        <p className="muted">Live overview of your charging network.</p>
      </header>

      {/* Live charger cards */}
      {chargers.length > 0 && (
        <>
          <h2 className="dash-section-title">
            {'\u26A1'} Live Chargers
          </h2>
          <div className="chgr-grid" style={{ marginBottom: 20 }}>
            {chargers.map((ch) => (
              <ChargerStatusCard key={ch.id} charger={ch} offlineConnectors={offlineConnectors} addToast={addToast} />
            ))}
          </div>
        </>
      )}

      {/* Stats cards */}
      <div className="dash-stats">
        <Stat icon={'\u26A1'} label="Charging Now" value={chargingNow} color="var(--amber)" />
        <Stat icon={'\uD83D\uDD0B'} label="Active Sessions" value={activeSessions} color="var(--blue)" />
        <Stat icon={'\uD83C\uDF10'} label="Online / Total" value={`${online}/${chargers.length}`} color="var(--teal)" />
        <Stat icon={'\uD83D\uDCCA'} label="Energy Today" value={`${todayEnergy.toFixed(1)} kWh`} color="var(--blue)" />
        <Stat icon={'\uD83D\uDCB0'} label="Revenue Today" value={`$${todayRevenue.toFixed(2)}`} color="var(--amber)" />
        <Stat icon={'\uD83D\uDCC8'} label="Total Revenue" value={`$${totalRevenue.toFixed(2)}`} color="var(--teal)" />
      </div>

      {/* Main grid: chart + sessions */}
      <div className="dash-grid-2col">
        <div className="dash-section">
          <h2>Energy Last 7 Days</h2>
          {dailyData.length === 0 ? (
            <p className="dash-empty">{EMPTY_ENERGY_CHART}</p>
          ) : (
            <>
              <div className="dash-mini-stat">
                <span><svg viewBox="0 0 16 16" fill="currentColor" width="12" height="12" style={{ marginRight: 3, opacity: 0.6 }}><rect x="1" y="3" width="14" height="11" rx="2" /><line x1="1" y1="7" x2="15" y2="7" /><circle cx="8" cy="11" r="1.5" /></svg>{totalSessions7d} sessions</span>
                <span><svg viewBox="0 0 16 16" fill="currentColor" width="12" height="12" style={{ marginRight: 3, opacity: 0.6 }}><path d="M8 1L3 6h3v5h4V6h3L8 1z"/></svg>{energy7d.toFixed(1)} kWh total</span>
              </div>
              <div style={{ width: '100%', height: 140 }}>
                <ResponsiveContainer>
                  <BarChart data={dailyData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                    <XAxis dataKey="day" tick={{ fill: 'var(--text-muted)', fontSize: 10 }} stroke="var(--border)" />
                    <YAxis tick={{ fill: 'var(--text-muted)', fontSize: 10 }} stroke="var(--border)" />
                    <Tooltip
                      contentStyle={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 6, fontSize: 12 }}
                      labelStyle={{ color: 'var(--text-primary)' }}
                    />
                    <Bar dataKey="energy" fill="var(--amber)" radius={[4, 4, 0, 0]} name="kWh" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </>
          )}
        </div>

        <div className="dash-section">
          <h2>Recent Sessions</h2>
          {recentSessions.length === 0 ? (
            <p className="dash-empty">{EMPTY_RECENT_SESSIONS}</p>
          ) : (
            <div className="dash-sessions">
              <div className="dash-session-header">
                <span><svg viewBox="0 0 16 16" fill="currentColor" width="10" height="10" style={{ marginRight: 3 }}><rect x="3" y="1" width="10" height="14" rx="2" /></svg>Charger</span>
                <span><svg viewBox="0 0 16 16" fill="currentColor" width="10" height="10" style={{ marginRight: 3 }}><path d="M8 1L3 6h3v5h4V6h3L8 1z"/></svg>Energy</span>
                <span>Cost</span>
              </div>
              {recentSessions.map((s) => (
                <div key={s.id} className="dash-session-row">
                  <span className="dash-session-charger">
                    <svg viewBox="0 0 16 16" fill="currentColor" width="12" height="12" style={{ marginRight: 4, flexShrink: 0, opacity: 0.5 }}><rect x="3" y="1" width="10" height="14" rx="2" /><line x1="7" y1="4" x2="7" y2="7" /><line x1="9" y1="4" x2="9" y2="7" /><line x1="7" y1="9" x2="7" y2="12" /><line x1="9" y1="9" x2="9" y2="12" /></svg>
                    {s.charger_id}{s.connector_id != null ? ` #${s.connector_id}` : ''}
                  </span>
                  <span><svg viewBox="0 0 16 16" fill="currentColor" width="10" height="10" style={{ marginRight: 3, opacity: 0.5 }}><path d="M8 1L3 6h3v5h4V6h3L8 1z"/></svg>{s.energy_kwh ? `${s.energy_kwh.toFixed(1)}` : '-'}</span>
                  <span className="dash-session-cost">${(s.total_cost || s.total_amount || 0).toFixed(2)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function Stat({ icon, label, value, color }) {
  return (
    <div className="dash-stat">
      <div className="dash-stat-icon">{icon}</div>
      <div className="dash-stat-body">
        <div className="dash-stat-label">{label}</div>
        <div className="dash-stat-value" style={{ color }}>{value}</div>
      </div>
    </div>
  );
}
