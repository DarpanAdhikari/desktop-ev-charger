import { useParams, useNavigate } from 'react-router-dom';
import { useState } from 'react';
import { useChargers, useLiveEvents } from '../hooks/useVoltDesk';
import { sendAction } from '../services/ipc';

export default function ChargerDetailPage({ addToast }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const { chargers, loading, refresh } = useChargers();
  const [acting, setActing] = useState(null);

  useLiveEvents({ onChargerEvent: () => refresh() });

  const charger = chargers.find((c) => c.id === id);

  const handleAction = async (connectorId, action) => {
    if (acting) return;
    setActing(`${connectorId}_${action}`);
    try {
      const result = await sendAction({
        charger_id: id,
        connector_id: connectorId,
        action,
      });
      if (result.sent) {
        addToast(`${action} command sent to ${id} connector ${connectorId}`, 'info');
      } else {
        addToast(`${action} rejected: ${result.reason}`, 'error');
      }
    } catch (e) {
      addToast(`Failed to send ${action}: ${e.message}`, 'error');
    } finally {
      setActing(null);
      refresh();
    }
  };

  if (loading) {
    return <div className="empty-state"><p>Loading...</p></div>;
  }

  if (!charger) {
    return (
      <>
        <button className="back-btn" onClick={() => navigate('/chargers')}>Back to Chargers</button>
        <div className="empty-state"><p>Charger not found.</p></div>
      </>
    );
  }

  return (
    <>
      <header className="view-header">
        <button className="back-btn" onClick={() => navigate('/chargers')}>Back to Chargers</button>
        <h1>{charger.id}</h1>
        <p className="muted">
          {charger.vendor || 'Unknown'} {charger.model ? `- ${charger.model}` : ''}
          {' '}<span className={`pill ${charger.online ? 'online' : 'offline'}`}>
            {charger.online ? 'Online' : 'Offline'}
          </span>
        </p>
      </header>

      <div className="connector-grid">
        {(charger.connectors || []).map((con) => {
          const meter = con._meter || null;
          const session = meter?.session || {};
          const delta = meter?.delta || {};
          const meterValues = meter?.meter || {};
          const activeTx = (charger.active_transactions || []).find(
            (tx) => tx.connector_id === con.connector_id
          );
          const soc = meter?.soc ?? activeTx?.soc_end ?? activeTx?.soc_start ?? 0;
          const pct = Math.min(Math.max(Number(soc) || 0, 0), 100);
          const isLiveCharging = Number(meter?.power_kw ?? meter?.rate_kw) > 0;
          const isCharging = (con.status || '').toLowerCase() === 'charging' || isLiveCharging || !!activeTx;
          const liveStatus = isCharging ? 'charging' : (con.status || 'unknown').toLowerCase();
          const canStart = ['available', 'preparing'].includes((con.status || '').toLowerCase()) && !isLiveCharging;
          const canStop = !!activeTx;
          const rateMode = meter?.charging_rate_mode === 'kw' ? 'kw' : 'percentage';
          const rateLabel = rateMode === 'kw'
            ? formatRate(meter?.rateKw ?? meter?.rate_kw, 'kW')
            : formatRate(meter?.ratePerMin ?? meter?.rate_per_min, '%/min');
          const sessionEnergy = Number(session.energy ?? activeTx?.energy_kwh ?? meter?.energy_kwh ?? 0);
          const elapsedSec = Number(session.elapsed_sec ?? activeTx?.duration_sec ?? 0);
          const amountLabel = formatCurrency(meter?.total_amount);
          const tariffLabel = meter?.rate_per_kwh != null ? `$${Number(meter.rate_per_kwh).toFixed(2)}/kWh` : null;

          return (
            <div key={con.connector_id} className={`connector-card connector-${liveStatus}`}>
              <div className="ring-wrap">
                <RingSvg percent={pct} statusClass={isCharging ? 'charging' : statusClass(con.status)} />
                <div className="ring-center">
                  <span className="pct">{Math.round(pct)}%</span>
                  <span className="label">SoC</span>
                </div>
              </div>

              <h3>Connector {con.connector_id}</h3>
              <div className="status-text" style={{ color: statusColor(liveStatus) }}>
                {liveStatus.toUpperCase()}
                {con.error_code && con.error_code !== 'NoError' ? ` - ${con.error_code}` : ''}
              </div>

              {(activeTx || meter) && (
                <div className="tx-info">
                  {activeTx && <span>Tx #{activeTx.ocpp_tx_id}</span>}
                  <div className="live-amount-row">
                    <span key={amountLabel || 'amount'} className="live-amount">{amountLabel || '$0.00'}</span>
                    {tariffLabel && <span className="live-rate">{tariffLabel}{meter?.shift_name ? ` - ${meter.shift_name}` : ''}</span>}
                  </div>
                  <div className="connector-metrics">
                    <Metric label="Session" value={`${sessionEnergy.toFixed(2)} kWh`} />
                    <Metric label="Power" value={formatNullable(meterValues.power ?? meter?.power_kw, 'kW')} />
                    <Metric label="Duration" value={elapsedSec > 0 ? formatDuration(elapsedSec) : '-'} />
                    <Metric label="SoC" value={meter?.soc != null ? `${Math.round(meter.soc)}%` : '-'} />
                    <Metric label="Delta Energy" value={formatNullable(delta.energy, 'kWh')} />
                    <Metric label="Delta SoC" value={formatNullable(delta.soc, '%')} />
                    <Metric label="Voltage" value={formatNullable(meterValues.voltage, 'V')} />
                    <Metric label="Current" value={formatNullable(meterValues.current, 'A')} />
                  </div>
                  {session.soc_start != null && session.soc_end != null ? (
                    <span>Session SoC: {session.soc_start}% to {session.soc_end}%</span>
                  ) : null}
                  {rateLabel && <span>Charging rate: {rateLabel}</span>}
                  {meter?.eta_minutes != null && (
                    <span style={{ color: 'var(--amber)' }}>
                      ETA: ~{formatDuration(meter.eta_minutes * 60)}
                      {meter.soc != null ? ` (${Math.round(meter.soc)}% to 100%)` : ''}
                    </span>
                  )}
                </div>
              )}

              <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
                {canStart && (
                  <button
                    className="btn primary"
                    disabled={acting === `${con.connector_id}_START`}
                    onClick={() => handleAction(con.connector_id, 'START')}
                  >
                    {acting === `${con.connector_id}_START` ? 'Sending...' : 'Start'}
                  </button>
                )}
                {canStop && (
                  <button
                    className="btn danger"
                    disabled={acting === `${con.connector_id}_STOP`}
                    onClick={() => handleAction(con.connector_id, 'STOP')}
                  >
                    {acting === `${con.connector_id}_STOP` ? 'Sending...' : 'Stop'}
                  </button>
                )}
                {!canStart && !canStop && (
                  <button className="btn ghost" disabled>Start</button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

function Metric({ label, value }) {
  return (
    <div className="connector-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function RingSvg({ percent, statusClass }) {
  const r = 52;
  const circ = 2 * Math.PI * r;
  const offset = circ - (percent / 100) * circ;
  const color = statusClass === 'charging' ? '#FFC857'
    : statusClass === 'available' ? '#3DDC97'
    : statusClass === 'faulted' ? '#FF5D5D'
    : '#4A5160';

  return (
    <svg width="120" height="120" viewBox="0 0 120 120">
      <circle cx="60" cy="60" r={r} fill="none" stroke="#262B35" strokeWidth="8" />
      <circle
        cx="60" cy="60" r={r}
        fill="none"
        stroke={color}
        strokeWidth="8"
        strokeDasharray={circ}
        strokeDashoffset={offset}
        strokeLinecap="round"
        style={{ transition: 'stroke-dashoffset 0.5s ease' }}
      />
    </svg>
  );
}

function statusClass(status) {
  switch ((status || '').toLowerCase()) {
    case 'charging': return 'charging';
    case 'available': return 'available';
    case 'faulted':
    case 'error': return 'faulted';
    default: return 'unavailable';
  }
}

function statusColor(status) {
  switch ((status || '').toLowerCase()) {
    case 'charging': return 'var(--amber)';
    case 'available': return 'var(--teal)';
    case 'faulted':
    case 'error': return 'var(--red)';
    case 'preparing':
    case 'finishing': return 'var(--blue)';
    default: return 'var(--slate)';
  }
}

function formatDuration(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatRate(value, unit) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return null;
  return `${num.toFixed(unit === 'kW' ? 1 : 2)} ${unit}`;
}

function formatNullable(value, unit) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '-';
  const precision = unit === '%' ? 0 : 2;
  return `${num.toFixed(precision)} ${unit}`;
}

function formatCurrency(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return `$${num.toFixed(2)}`;
}
