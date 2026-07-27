import { useCallback, useEffect, useState } from 'react';
import { useLogs, useLiveEvents } from '../hooks/useVoltDesk';
import { exportCsv } from '../services/ipc';
import EmptyState from '../components/EmptyState';

const PAGE_SIZE = 20;

export default function LogsPage({ addToast }) {
  const { logs, total, loading, refresh } = useLogs();
  const [page, setPage] = useState(1);
  const totalPages = Math.ceil(total / PAGE_SIZE) || 1;

  const loadPage = useCallback((p) => {
    setPage(p);
    refresh({ limit: PAGE_SIZE, offset: (p - 1) * PAGE_SIZE });
  }, [refresh]);

  useEffect(() => { loadPage(1); }, [loadPage]);

  useLiveEvents({ onLogEvent: () => loadPage(1) });

  if (loading && logs.length === 0) {
    return <div className="empty-state"><p>Loading logs...</p></div>;
  }

  return (
    <>
      <header className="view-header">
        <h1>Logs</h1>
        <p className="muted">Raw event stream from the CSMS.</p>
      </header>

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
        {total > 0 && (
          <button className="btn ghost" onClick={async () => {
            const cols = ['id', 'ts', 'charger_id', 'type', 'payload'];
            const result = await exportCsv({ data: logs, columns: cols, filename: 'logs.csv' });
            if (result.success) addToast(`Exported to ${result.path}`, 'success');
            else if (result.reason !== 'canceled') addToast(`Export failed: ${result.reason}`, 'error');
          }}>Export CSV</button>
        )}
      </div>

      {total === 0 ? (
        <EmptyState message="No logs yet. Events appear here when the CSMS is connected." />
      ) : (
        <>
          <div className="log-table">
            {logs.map((log) => (
              <div key={log.id} className="log-row">
                <span className="log-time">{formatLocal(log.ts)}</span>
                <span className="log-charger">{log.charger_id || '—'}</span>
                <span className="log-type">{log.type}</span>
                <span className="log-payload">{prettyJson(log.payload)}</span>
              </div>
            ))}
          </div>

          <footer className="pagination">
            <button
              className="page-btn"
              disabled={page <= 1 || loading}
              onClick={() => loadPage(page - 1)}
            >« Prev</button>
            <span className="page-info">Page {page} / {totalPages}</span>
            <button
              className="page-btn"
              disabled={page >= totalPages || loading}
              onClick={() => loadPage(page + 1)}
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
