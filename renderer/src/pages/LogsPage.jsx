import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLogs, useLiveEvents } from '../hooks/useVoltDesk';
import { exportCsv, exportAllLogs } from '../services/ipc';
import EmptyState from '../components/EmptyState';
import {
  EXPORT_CSV, EXPORT_ALL_LOGS, EXPORTED_TO, EXPORT_FAILED,
  EMPTY_LOGS, LOADING_LOGS, LIVE_LABEL, PAUSED_LABEL,
  LOGS_SEARCH_PLACEHOLDER, ROWS_PER_PAGE,
} from '../strings';
import { LOGS_PAGE_SIZE, LOGS_PAGE_SIZES, SEARCH_DEBOUNCE_MS } from '../constants';

const SORTABLE = [
  { key: 'id', label: 'ID' },
  { key: 'ts', label: 'Time' },
  { key: 'charger_id', label: 'Charger' },
  { key: 'type', label: 'Type' },
  { key: 'payload', label: 'Payload' },
];

export default function LogsPage({ addToast }) {
  const { logs, total, loading, refresh } = useLogs();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(LOGS_PAGE_SIZE);
  const [live, setLive] = useState(true);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [sortField, setSortField] = useState('id');
  const [sortDir, setSortDir] = useState('desc');
  const liveRef = useRef(true);
  const pageRef = useRef(1);
  const optsRef = useRef({});
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const currentOpts = useMemo(() => ({ query, sortField, sortDir }), [query, sortField, sortDir]);

  const loadPage = useCallback((p, opts = {}) => {
    setPage(p);
    pageRef.current = p;
    optsRef.current = opts;
    refresh({ limit: pageSize, offset: (p - 1) * pageSize, ...opts });
  }, [pageSize, refresh]);

  useEffect(() => { loadPage(1, currentOpts); }, [loadPage, currentOpts]);

  useEffect(() => {
    const t = setTimeout(() => setQuery(search.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [search]);

  const handleToggleLive = (e) => {
    const next = e.target.checked;
    setLive(next);
    liveRef.current = next;
    if (next) loadPage(pageRef.current, optsRef.current);
  };

  useLiveEvents({ onLogEvent: () => { if (liveRef.current) loadPage(pageRef.current, optsRef.current); } });

  const toggleSort = (field) => {
    if (sortField === field) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortField(field); setSortDir('desc'); }
  };

  const sortIcon = (field) => {
    if (sortField !== field) return '';
    return sortDir === 'asc' ? ' \u25B2' : ' \u25BC';
  };

  const handleExportAll = async () => {
    const result = await exportAllLogs({ query });
    if (result.success) addToast(EXPORTED_TO(result.path), 'success');
    else if (result.reason !== 'canceled') addToast(EXPORT_FAILED(result.reason), 'error');
  };

  if (loading && logs.length === 0) {
    return <div className="empty-state"><p>{LOADING_LOGS}</p></div>;
  }

  return (
    <>
      <header className="view-header">
        <h1>Logs</h1>
        <p className="muted">Raw event stream from the CSMS.</p>
      </header>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <label className="toggle-switch">
          <input type="checkbox" checked={live} onChange={handleToggleLive} />
          <span className="toggle-slider" />
        </label>
        <span className="muted">{live ? LIVE_LABEL : PAUSED_LABEL}</span>
        <div className="floating-input" style={{ flex: 1, maxWidth: 360, marginLeft: 8 }}>
          <input
            type="text"
            placeholder=" "
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <label>{LOGS_SEARCH_PLACEHOLDER}</label>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          {total > 0 && (
            <button className="btn ghost" onClick={async () => {
              const cols = ['id', 'ts', 'charger_id', 'type', 'payload'];
              const result = await exportCsv({ data: logs, columns: cols, filename: 'logs.csv' });
              if (result.success) addToast(EXPORTED_TO(result.path), 'success');
              else if (result.reason !== 'canceled') addToast(EXPORT_FAILED(result.reason), 'error');
            }}>{EXPORT_CSV}</button>
          )}
          {total > 0 && (
            <button className="btn ghost" onClick={handleExportAll}>{EXPORT_ALL_LOGS}</button>
          )}
        </div>
      </div>

      {total === 0 ? (
        <EmptyState message={EMPTY_LOGS} />
      ) : (
        <>
          <div className="log-table">
            <div className="log-header">
              {SORTABLE.map((c) => (
                <span key={c.key} onClick={() => toggleSort(c.key)} className="tx-sortable">
                  {c.label}{sortIcon(c.key)}
                </span>
              ))}
            </div>
            {logs.map((log) => (
              <div key={log.id} className="log-row">
                <span className="log-id">{log.id}</span>
                <span className="log-time">{formatLocal(log.ts)}</span>
                <span className="log-charger">{log.charger_id || '—'}</span>
                <span className="log-type">{log.type}</span>
                <span className="log-payload">{prettyJson(log.payload)}</span>
              </div>
            ))}
          </div>

          <footer className="pagination">
            <span className="muted" style={{ marginRight: 'auto' }}>{total} logs</span>
            <label className="muted" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              {ROWS_PER_PAGE}
              <select
                className="page-size"
                value={pageSize}
                onChange={(e) => setPageSize(Number(e.target.value))}
              >
                {LOGS_PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
            <button
              className="page-btn"
              disabled={page <= 1 || loading}
              onClick={() => loadPage(page - 1, optsRef.current)}
            >« Prev</button>
            <span className="page-info">Page {page} / {totalPages}</span>
            <button
              className="page-btn"
              disabled={page >= totalPages || loading}
              onClick={() => loadPage(page + 1, optsRef.current)}
            >Next »</button>
          </footer>
        </>
      )}
    </>
  );
}

function formatLocal(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  const seconds = String(d.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

function prettyJson(payload) {
  if (!payload) return '';
  try {
    const obj = typeof payload === 'string' ? JSON.parse(payload) : payload;
    return JSON.stringify(obj);
  } catch {
    return String(payload);
  }
}
