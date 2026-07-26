import { useLogs, useLiveEvents } from '../hooks/useVoltDesk';
import { exportCsv } from '../services/ipc';
import EmptyState from '../components/EmptyState';

export default function LogsPage({ addToast }) {
  const { logs, loading, refresh } = useLogs();

  useLiveEvents({ onLogEvent: () => refresh() });

  if (loading) {
    return <div className="empty-state"><p>Loading logs...</p></div>;
  }

  return (
    <>
      <header className="view-header">
        <h1>Logs</h1>
        <p className="muted">Raw event stream from the CSMS.</p>
      </header>

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
        {logs.length > 0 && (
          <button className="btn ghost" onClick={async () => {
            const cols = ['id', 'ts', 'charger_id', 'type', 'payload'];
            const result = await exportCsv({ data: logs, columns: cols, filename: 'logs.csv' });
            if (result.success) addToast(`Exported to ${result.path}`, 'success');
            else if (result.reason !== 'canceled') addToast(`Export failed: ${result.reason}`, 'error');
          }}>Export CSV</button>
        )}
      </div>

      {logs.length === 0 ? (
        <EmptyState message="No logs yet. Events appear here when the CSMS is connected." />
      ) : (
        <div className="log-table">
          {logs.map((log) => (
            <div key={log.id} className="log-row">
              <span className="log-time">{log.ts}</span>
              <span className="log-charger">{log.charger_id || '—'}</span>
              <span className="log-type">{log.type}</span>
              <span className="log-payload">{prettyJson(log.payload)}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
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
