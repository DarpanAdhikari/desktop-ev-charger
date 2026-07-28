import { useState, useMemo } from 'react';
import { useChargers, useLiveEvents } from '../hooks/useVoltDesk';
import EmptyState from '../components/EmptyState';
import ChargerStatusCard from '../components/ChargerStatusCard';

export default function ChargersPage({ refreshKey, addToast, offlineConnectors }) {
  const { chargers, loading, refresh } = useChargers();
  const [search, setSearch] = useState('');

  useLiveEvents({
    onChargerEvent: () => refresh(),
  });

  const filtered = useMemo(() => {
    if (!search.trim()) return chargers;
    const q = search.toLowerCase();
    return chargers.filter(
      (c) =>
        c.id.toLowerCase().includes(q) ||
        (c.vendor || '').toLowerCase().includes(q) ||
        (c.model || '').toLowerCase().includes(q)
    );
  }, [chargers, search]);

  if (loading) {
    return <div className="empty-state"><p>Loading chargers...</p></div>;
  }

  return (
    <>
      <header className="view-header">
        <h1>Chargers</h1>
        <p className="muted">Live status across every connected charge point.</p>
      </header>

      <div className="search-bar">
        <input
          type="text"
          placeholder="Search by ID, vendor, or model..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {filtered.length === 0 ? (
        <EmptyState message="No chargers found. Ensure the CSMS WebSocket is connected in Settings." />
      ) : (
        <div className="chgr-grid">
          {filtered.map((charger) => (
            <ChargerStatusCard key={charger.id} charger={charger} offlineConnectors={offlineConnectors} />
          ))}
        </div>
      )}
    </>
  );
}

function ChargerCard({ charger, onClick }) {
  const statusCounts = {};
  (charger.connectors || []).forEach((con) => {
    const s = (con.status || 'unknown').toLowerCase();
    statusCounts[s] = (statusCounts[s] || 0) + 1;
  });

  const activeTxCount = charger.active_transactions ? charger.active_transactions.length : 0;

  return (
    <div className="charger-card" onClick={onClick}>
      <h3>{charger.id}</h3>
      <div className="vendor">
        {charger.vendor || 'Unknown'} {charger.model ? `– ${charger.model}` : ''}
      </div>
      <span className={`pill ${charger.online ? 'online' : 'offline'}`}>
        {charger.online ? 'Online' : 'Offline'}
      </span>
      <div className="connector-chips">
        {(charger.connectors || []).map((con) => (
          <span key={con.connector_id} className="conn-chip">
            <span className={`dot ${statusClass(con.status)}`}></span>
            {con.connector_id}
          </span>
        ))}
      </div>
      {activeTxCount > 0 && (
        <div className="eta">{activeTxCount} active session{activeTxCount > 1 ? 's' : ''}</div>
      )}
    </div>
  );
}

function statusClass(status) {
  switch ((status || '').toLowerCase()) {
    case 'charging': return 'charging';
    case 'available': return 'available';
    case 'faulted':
    case 'error': return 'faulted';
    case 'preparing':
    case 'finishing': return 'preparing';
    default: return 'unavailable';
  }
}
