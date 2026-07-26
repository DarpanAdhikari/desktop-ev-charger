import { useState, useEffect, useCallback } from 'react';
import { listTransactions, transactionsStats, transactionsDaily, exportCsv } from '../services/ipc';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import EmptyState from '../components/EmptyState';

export default function TransactionsPage({ addToast }) {
  const [transactions, setTransactions] = useState([]);
  const [daily, setDaily] = useState([]);
  const [stats, setStats] = useState({ count: 0, total_energy: 0 });
  const [loading, setLoading] = useState(true);
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [sortField, setSortField] = useState('id');
  const [sortDir, setSortDir] = useState('desc');

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const opts = {};
      if (fromDate) opts.fromDate = new Date(fromDate).toISOString();
      if (toDate) opts.toDate = new Date(toDate + 'T23:59:59').toISOString();
      const [txns, st, dl] = await Promise.all([
        listTransactions(opts),
        transactionsStats(opts),
        transactionsDaily(opts),
      ]);
      setTransactions(txns);
      setStats(st);
      setDaily(dl);
    } catch (e) {
      console.error('Failed to load transactions:', e);
    } finally {
      setLoading(false);
    }
  }, [fromDate, toDate]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const sorted = [...transactions].sort((a, b) => {
    const va = a[sortField] ?? '';
    const vb = b[sortField] ?? '';
    const cmp = typeof va === 'string' ? va.localeCompare(vb) : va - vb;
    return sortDir === 'asc' ? cmp : -cmp;
  });

  const toggleSort = (field) => {
    if (sortField === field) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortField(field); setSortDir('desc'); }
  };

  const handleExport = async () => {
    const cols = ['id', 'charger_id', 'connector_id', 'ocpp_tx_id', 'started_at', 'stopped_at', 'duration_sec', 'energy_kwh', 'soc_start', 'soc_end', 'status'];
    const result = await exportCsv({ data: sorted, columns: cols, filename: 'transactions.csv' });
    if (result.success) addToast(`Exported to ${result.path}`, 'success');
    else if (result.reason !== 'canceled') addToast(`Export failed: ${result.reason}`, 'error');
  };

  const sortIcon = (field) => {
    if (sortField !== field) return '';
    return sortDir === 'asc' ? ' ▲' : ' ▼';
  };

  if (loading) return <div className="empty-state"><p>Loading transactions...</p></div>;

  return (
    <>
      <header className="view-header">
        <h1>Transactions</h1>
        <p className="muted">Charging session history and analytics.</p>
      </header>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 12, alignItems: 'end', marginBottom: 16, flexWrap: 'wrap' }}>
        <div className="form-group" style={{ margin: 0 }}>
          <label>From</label>
          <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} style={{ maxWidth: 180 }} />
        </div>
        <div className="form-group" style={{ margin: 0 }}>
          <label>To</label>
          <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} style={{ maxWidth: 180 }} />
        </div>
        <button className="btn ghost" onClick={fetchData}>Apply</button>
        <button className="btn ghost" onClick={() => { setFromDate(''); setToDate(''); }}>Clear</button>
        <button className="btn primary" onClick={handleExport} style={{ marginLeft: 'auto' }}>Export CSV</button>
      </div>

      {/* Stats */}
      <div style={{ display: 'flex', gap: 16, marginBottom: 16 }}>
        <StatChip label="Sessions" value={stats.count} color="var(--blue)" />
        <StatChip label="Total Energy" value={`${Number(stats.total_energy || 0).toFixed(1)} kWh`} color="var(--amber)" />
      </div>

      {/* Daily chart */}
      {daily.length > 0 && (
        <div className="settings-card full" style={{ marginBottom: 16, padding: 20 }}>
          <h2 style={{ fontFamily: "'Space Grotesk', sans-serif", fontWeight: 600, fontSize: 16, marginBottom: 12 }}>Daily Sessions</h2>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={daily}>
              <CartesianGrid strokeDasharray="3 3" stroke="#262B35" />
              <XAxis dataKey="day" tick={{ fill: '#9CA3B2', fontSize: 12 }} stroke="#323846" />
              <YAxis tick={{ fill: '#9CA3B2', fontSize: 12 }} stroke="#323846" />
              <Tooltip
                contentStyle={{ background: '#171B22', border: '1px solid #262B35', borderRadius: 6 }}
                labelStyle={{ color: '#E8EDF5' }}
              />
              <Bar dataKey="count" fill="#FFC857" radius={[4, 4, 0, 0]} name="Sessions" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Table */}
      {sorted.length === 0 ? (
        <EmptyState message="No transactions match your filters." />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <div className="log-row" style={{ fontWeight: 600, cursor: 'pointer', color: 'var(--text-secondary)' }}>
            <span onClick={() => toggleSort('id')} style={{ cursor: 'pointer' }}>ID{sortIcon('id')}</span>
            <span onClick={() => toggleSort('charger_id')} style={{ cursor: 'pointer' }}>Charger{sortIcon('charger_id')}</span>
            <span>Conn</span>
            <span onClick={() => toggleSort('started_at')} style={{ cursor: 'pointer' }}>Start{sortIcon('started_at')}</span>
            <span onClick={() => toggleSort('stopped_at')} style={{ cursor: 'pointer' }}>Stop{sortIcon('stopped_at')}</span>
            <span onClick={() => toggleSort('duration_sec')} style={{ cursor: 'pointer' }}>Duration{sortIcon('duration_sec')}</span>
            <span onClick={() => toggleSort('energy_kwh')} style={{ cursor: 'pointer' }}>Energy{sortIcon('energy_kwh')}</span>
            <span onClick={() => toggleSort('status')} style={{ cursor: 'pointer' }}>Status{sortIcon('status')}</span>
          </div>
          {sorted.map((tx) => (
            <div key={tx.id} className="log-row" style={{ fontSize: 12, fontFamily: "'JetBrains Mono', monospace" }}>
              <span style={{ color: 'var(--text-muted)' }}>{tx.id}</span>
              <span style={{ color: 'var(--blue)' }}>{tx.charger_id}</span>
              <span>{tx.connector_id}</span>
              <span style={{ color: 'var(--text-secondary)' }}>{tx.started_at ? new Date(tx.started_at).toLocaleString() : '—'}</span>
              <span style={{ color: 'var(--text-secondary)' }}>{tx.stopped_at ? new Date(tx.stopped_at).toLocaleString() : '—'}</span>
              <span>{tx.duration_sec ? formatDuration(tx.duration_sec) : '—'}</span>
              <span style={{ color: 'var(--amber)' }}>{(tx.energy_kwh || 0).toFixed(2)}</span>
              <span style={{ color: tx.status === 'active' ? 'var(--amber)' : 'var(--text-muted)' }}>{tx.status}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function StatChip({ label, value, color }) {
  return (
    <div style={{
      background: 'var(--bg-surface)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius-sm)',
      padding: '10px 16px',
      display: 'flex',
      gap: 8,
      alignItems: 'center',
    }}>
      <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{label}</span>
      <span style={{ fontSize: 16, fontWeight: 700, color, fontFamily: "'JetBrains Mono', monospace" }}>{value}</span>
    </div>
  );
}

function formatDuration(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
