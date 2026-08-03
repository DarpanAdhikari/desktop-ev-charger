import { useState, useEffect, useCallback, useMemo } from 'react';
import { listTransactions, transactionsStats, transactionsDaily, exportCsv } from '../services/ipc';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import EmptyState from '../components/EmptyState';
import { formatDuration } from '../utils';
import { EXPORT_CSV, EXPORTED_TO, EXPORT_FAILED, EMPTY_TRANSACTIONS, APPLY_LABEL, CLEAR_LABEL } from '../strings';

export default function TransactionsPage({ addToast }) {
  const [transactions, setTransactions] = useState([]);
  const [daily, setDaily] = useState([]);
  const [stats, setStats] = useState({ count: 0, total_energy: 0 });
  const [loading, setLoading] = useState(true);
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [search, setSearch] = useState('');
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

  const filtered = useMemo(() => {
    let list = transactions;
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter((t) =>
        (t.charger_id || '').toLowerCase().includes(q) ||
        (t.customer_name || '').toLowerCase().includes(q) ||
        String(t.ocpp_tx_id || '').includes(q)
      );
    }
    return list;
  }, [transactions, search]);

  const sorted = useMemo(() =>
    [...filtered].sort((a, b) => {
      const va = a[sortField] ?? '';
      const vb = b[sortField] ?? '';
      const cmp = typeof va === 'string' ? va.localeCompare(vb) : va - vb;
      return sortDir === 'asc' ? cmp : -cmp;
    }),
    [filtered, sortField, sortDir]
  );

  const toggleSort = (field) => {
    if (sortField === field) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortField(field); setSortDir('desc'); }
  };

  const handleExport = async () => {
    const cols = ['id', 'charger_id', 'connector_id', 'ocpp_tx_id', 'customer_name', 'started_at', 'stopped_at', 'duration_sec', 'energy_kwh', 'total_amount', 'soc_start', 'soc_end', 'status'];
    const result = await exportCsv({ data: sorted, columns: cols, filename: 'transactions.csv' });
    if (result.success) addToast(EXPORTED_TO(result.path), 'success');
    else if (result.reason !== 'canceled') addToast(EXPORT_FAILED(result.reason), 'error');
  };

  const sortIcon = (field) => {
    if (sortField !== field) return '';
    return sortDir === 'asc' ? ' \u25B2' : ' \u25BC';
  };

  if (loading) {
    return (
      <>
        <header className="view-header">
          <h1>Transactions</h1>
          <p className="muted">Charging session history and analytics.</p>
        </header>
        <div style={{ display: 'flex', gap: 16, marginBottom: 16 }}>
          <div className="skeleton" style={{ width: 120, height: 44, borderRadius: 8 }} />
          <div className="skeleton" style={{ width: 160, height: 44, borderRadius: 8 }} />
        </div>
      </>
    );
  }

  const totalRevenue = sorted.reduce((s, t) => s + (t.total_amount || t.total_cost || 0), 0);

  return (
    <>
      <header className="view-header">
        <h1>Transactions</h1>
        <p className="muted">Charging session history and analytics.</p>
      </header>

      {/* Filters */}
      <div className="billing-filters">
        <div className="floating-input">
          <input
            type="text"
            placeholder=" "
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <label>Search charger ID, customer, Tx #...</label>
        </div>
        <div className="floating-input" style={{ maxWidth: 160 }}>
          <input type="date" placeholder=" " value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
          <label>From</label>
        </div>
        <div className="floating-input" style={{ maxWidth: 160 }}>
          <input type="date" placeholder=" " value={toDate} onChange={(e) => setToDate(e.target.value)} />
          <label>To</label>
        </div>
        <button className="btn ghost" onClick={fetchData}>{APPLY_LABEL}</button>
        <button className="btn ghost" onClick={() => { setFromDate(''); setToDate(''); }}>{CLEAR_LABEL}</button>
        <button className="btn primary" onClick={handleExport} style={{ marginLeft: 'auto' }}>{EXPORT_CSV}</button>
      </div>

      {/* Stats */}
      <div className="dash-stats" style={{ marginBottom: 16 }}>
        <StatChip label="Sessions" value={stats.count} color="var(--blue)" />
        <StatChip label="Total Energy" value={`${Number(stats.total_energy || 0).toFixed(1)} kWh`} color="var(--amber)" />
        <StatChip label="Revenue" value={`$${totalRevenue.toFixed(2)}`} color="var(--teal)" />
        <StatChip label="Active Now" value={sorted.filter((t) => t.status === 'active').length} color="var(--amber)" />
      </div>

      {/* Daily chart */}
      {daily.length > 0 && (
        <div className="settings-card full" style={{ marginBottom: 16, padding: 20 }}>
          <h2 className="dash-section-title">Daily Sessions</h2>
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={daily}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="day" tick={{ fill: 'var(--text-muted)', fontSize: 11 }} stroke="var(--border)" />
              <YAxis tick={{ fill: 'var(--text-muted)', fontSize: 11 }} stroke="var(--border)" />
              <Tooltip
                contentStyle={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 6 }}
                labelStyle={{ color: 'var(--text-primary)' }}
              />
              <Bar dataKey="count" fill="var(--amber)" radius={[4, 4, 0, 0]} name="Sessions" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Table */}
      {sorted.length === 0 ? (
        <EmptyState message={EMPTY_TRANSACTIONS} />
      ) : (
        <div className="tx-table">
          <div className="tx-header">
            <span onClick={() => toggleSort('id')} className="tx-sortable">ID{sortIcon('id')}</span>
            <span onClick={() => toggleSort('charger_id')} className="tx-sortable">Charger{sortIcon('charger_id')}</span>
            <span>Conn</span>
            <span>Customer</span>
            <span onClick={() => toggleSort('started_at')} className="tx-sortable">Start{sortIcon('started_at')}</span>
            <span onClick={() => toggleSort('duration_sec')} className="tx-sortable">Duration{sortIcon('duration_sec')}</span>
            <span onClick={() => toggleSort('energy_kwh')} className="tx-sortable">Energy{sortIcon('energy_kwh')}</span>
            <span>Cost</span>
            <span onClick={() => toggleSort('status')} className="tx-sortable">Status{sortIcon('status')}</span>
          </div>
          {sorted.map((tx) => (
            <div key={tx.id} className="tx-row">
              <span className="tx-id">{tx.id}</span>
              <span className="tx-charger">{tx.charger_id}</span>
              <span className="tx-conn">{tx.connector_id}</span>
              <span className="tx-customer">{tx.customer_name || '\u2014'}</span>
              <span className="tx-start">{tx.started_at ? new Date(tx.started_at).toLocaleString() : '\u2014'}</span>
              <span className="tx-duration">{tx.duration_sec ? formatDuration(tx.duration_sec) : '\u2014'}</span>
              <span className="tx-energy">{(tx.energy_kwh || 0).toFixed(2)}</span>
              <span className="tx-cost">${(tx.total_amount || tx.total_cost || 0).toFixed(2)}</span>
              <span className={`tx-status status-${tx.status}`}>{tx.status}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function StatChip({ label, value, color }) {
  return (
    <div className="dash-stat" style={{ padding: '10px 14px', gap: 8 }}>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 700, color, fontFamily: "'JetBrains Mono', monospace" }}>{value}</div>
    </div>
  );
}
