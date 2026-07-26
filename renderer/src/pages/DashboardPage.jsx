import { useChargers, useBills, useLiveEvents } from '../hooks/useVoltDesk';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import ChargerStatusCard from '../components/ChargerStatusCard';

export default function DashboardPage({ addToast }) {
  const { chargers, loading, refresh } = useChargers();
  const { bills } = useBills();

  useLiveEvents({ onChargerEvent: () => refresh() });

  if (loading) {
    return <div className="empty-state"><p>Loading dashboard...</p></div>;
  }

  const online = chargers.filter((c) => c.online).length;
  const offline = chargers.filter((c) => !c.online).length;
  const activeSessions = chargers.reduce(
    (sum, c) => sum + (c.active_transactions ? c.active_transactions.length : 0), 0
  );
  const chargingNow = chargers.filter((c) =>
    (c.connectors || []).some((con) => (con.status || '').toLowerCase() === 'charging')
  ).length;
  const totalEnergy = bills.reduce((sum, b) => sum + (b.energy_kwh || 0), 0);
  const totalRevenue = bills.reduce((sum, b) => sum + (b.total || 0), 0);
  const todayRevenue = bills
    .filter((b) => b.created_at && new Date(b.created_at).toDateString() === new Date().toDateString())
    .reduce((sum, b) => sum + (b.total || 0), 0);
  const todayEnergy = bills
    .filter((b) => b.created_at && new Date(b.created_at).toDateString() === new Date().toDateString())
    .reduce((sum, b) => sum + (b.energy_kwh || 0), 0);

  const recentBills = bills.slice(0, 5);

  return (
    <>
      <header className="view-header">
        <h1>Dashboard</h1>
        <p className="muted">Live overview of your charging network.</p>
      </header>

      {/* Stats bar */}
      <div className="dash-stats">
        <Stat icon="⚡" label="Charging Now" value={chargingNow} color="var(--amber)" />
        <Stat icon="🔋" label="Active Sessions" value={activeSessions} color="var(--blue)" />
        <Stat icon="🌐" label="Online / Total" value={`${online}/${chargers.length}`} color="var(--teal)" />
        <Stat icon="📊" label="Energy Today" value={`${todayEnergy.toFixed(1)} kWh`} color="var(--blue)" />
        <Stat icon="💰" label="Revenue Today" value={`$${todayRevenue.toFixed(2)}`} color="var(--amber)" />
        <Stat icon="📈" label="Total Revenue" value={`$${totalRevenue.toFixed(2)}`} color="var(--teal)" />
      </div>

      {/* Live charger cards */}
      {chargers.length > 0 && (
        <>
          <h2 style={{
            fontFamily: "'Space Grotesk', sans-serif", fontWeight: 600, fontSize: 15,
            marginBottom: 12, color: 'var(--text-secondary)',
          }}>
            ⚡ Live Chargers
          </h2>
          <div className="chgr-grid" style={{ marginBottom: 20 }}>
            {chargers.map((ch) => (
              <ChargerStatusCard key={ch.id} charger={ch} />
            ))}
          </div>
        </>
      )}

      {/* Bottom row: recent activity + revenue chart */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <div className="dash-section">
          <h2>Recent Bills</h2>
          {recentBills.length === 0 ? (
            <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>No bills yet.</p>
          ) : (
            recentBills.map((b) => (
              <div key={b.id} className="dash-row">
                <span>{b.bill_number}</span>
                <span style={{ color: 'var(--amber)' }}>${(b.total || 0).toFixed(2)}</span>
              </div>
            ))
          )}
        </div>
        <div className="dash-section">
          <h2>Energy Consumed</h2>
          {totalEnergy === 0 ? (
            <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>No data yet.</p>
          ) : (
            <div style={{ width: '100%', height: 120 }}>
              <ResponsiveContainer>
                <BarChart data={[
                  { name: 'Total', energy: totalEnergy },
                ]}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="name" tick={{ fill: 'var(--text-muted)', fontSize: 11 }} stroke="var(--border)" />
                  <YAxis tick={{ fill: 'var(--text-muted)', fontSize: 11 }} stroke="var(--border)" />
                  <Tooltip
                    contentStyle={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 6 }}
                    labelStyle={{ color: 'var(--text-primary)' }}
                  />
                  <Bar dataKey="energy" fill="var(--amber)" radius={[4, 4, 0, 0]} name="kWh" />
                </BarChart>
              </ResponsiveContainer>
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
