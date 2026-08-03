import { useNavigate } from 'react-router-dom';
import { useContextMenu } from '../hooks/useContextMenu.jsx';
import { sendAction } from '../services/ipc';
import { formatRate, formatCurrency, formatMin, statusDotClass } from '../utils';
import { ATTENTION_ACTION, CONNECTOR_START, CONNECTOR_STOP, OPEN_CHARGER, commandSentText, commandRejectedText, failedToSendText } from '../strings';

export default function ChargerStatusCard({ charger, offlineConnectors, addToast }) {
  const navigate = useNavigate();
  const { openMenu } = useContextMenu();

  const sendQuickAction = async (connectorId, action) => {
    try {
      const result = await sendAction({
        charger_id: charger.id,
        connector_id: connectorId,
        action,
      });
      if (result.sent) addToast(commandSentText(action, charger.id, connectorId), 'info');
      else addToast(commandRejectedText(action, result.reason), 'error');
    } catch (e) {
      addToast(failedToSendText(action, e.message), 'error');
    }
  };

  const handleContextMenu = (e) => {
    const items = [
      { label: OPEN_CHARGER(charger.id), run: () => navigate(`/chargers/${charger.id}`) },
      { separator: true },
    ];
    (charger.connectors || []).forEach((con) => {
      const st = (con.status || '').toLowerCase();
      const canStart = ['available', 'preparing'].includes(st);
      const canStop = (charger.active_transactions || []).some((tx) => tx.connector_id === con.connector_id);
      items.push({
        label: CONNECTOR_START(con.connector_id),
        disabled: !canStart,
        run: () => sendQuickAction(con.connector_id, 'START'),
      });
      items.push({
        label: CONNECTOR_STOP(con.connector_id),
        disabled: !canStop,
        run: () => sendQuickAction(con.connector_id, 'STOP'),
      });
    });
    openMenu(e, items);
  };
  const hasActiveTx = (charger.active_transactions || []).length > 0;
  const allOffline = (charger.connectors || []).length > 0 && (charger.connectors || []).every(
    (c) => offlineConnectors?.[`${charger.id}:${c.connector_id}`]
  );
  const primaryConnector = (charger.connectors || []).find((con) => con._meter)
    || (charger.connectors || [])[0];
  const meter = primaryConnector ? primaryConnector._meter : null;
  const isCharging = !allOffline && (charger.connectors || []).some(
    (c) => (c.status || '').toLowerCase() === 'charging'
  );
  const activeTx = charger.active_transactions ? charger.active_transactions[0] : null;
  const soc = meter?.soc ?? (activeTx ? activeTx.soc_end || activeTx.soc_start || 0 : 0);
  const pct = Math.min(Math.max(soc, 0), 100);
  const etaMinutes = meter ? meter.eta_minutes : null;
  const rateMode = meter?.charging_rate_mode === 'kw' ? 'kw' : 'percentage';
  const rateLabel = rateMode === 'kw'
    ? formatRate(meter?.rateKw ?? meter?.rate_kw, 'kW')
    : formatRate(meter?.ratePerMin ?? meter?.rate_per_min, '%/min');
  const amountLabel = formatCurrency(meter?.total_amount);

  const connectorSummary = countStatuses(charger.connectors);
  const online = charger.online;
  const statusKey = isCharging ? 'charging' : (online && !allOffline) ? 'available' : 'offline';
  const hasFault = connectorSummary.faulted > 0;

  return (
    <div
      className={`chgr-card chgr-${statusKey} ${hasFault ? 'chgr-fault' : ''}`}
      onClick={() => navigate(`/chargers/${charger.id}`)}
      onContextMenu={handleContextMenu}
    >
      {/* Top bar: charger ID + status badge */}
      <div className="chgr-top">
        <span className="chgr-id">{charger.id}</span>
        {(charger.active_transactions || []).some((tx) => tx.flagged) && (
          <span className="chgr-attention" title={`Session needs attention \u2014 ${ATTENTION_ACTION}`}>
            ATTENTION
          </span>
        )}
        <span className={`chgr-badge ${statusKey}`}>
          {statusKey === 'charging' ? 'CHARGING' : statusKey === 'offline' ? 'OFFLINE' : 'ONLINE'}
        </span>
      </div>

      {/* Center: SVG nozzle + battery visualization */}
      <div className="chgr-visual">
        <svg className="chgr-svg" viewBox="0 0 120 80" width="120" height="80">
          {/* Nozzle body */}
          <rect x={isCharging ? '46' : '48'} y="16" width="8" height="28" rx="2"
            fill={isCharging ? '#FFC857' : online ? '#3DDC97' : '#4A5160'}
            className={isCharging ? 'chrg-glow' : ''}
          />
          {/* Nozzle tip */}
          <rect x={isCharging ? '44' : '46'} y="44" width="12" height="6" rx="1"
            fill={isCharging ? '#FFC857' : online ? '#3DDC97' : '#4A5160'}
          />
          {/* Cable (curved line) */}
          <path d="M50 44 Q50 58 38 62 Q26 66 26 56"
            fill="none"
            stroke={isCharging ? '#FFC857' : online ? '#3DDC97' : '#4A5160'}
            strokeWidth="3"
            strokeLinecap="round"
            className={isCharging ? 'chrg-cable' : ''}
          />
          {/* Plug end */}
          <rect x="20" y="52" width="8" height="8" rx="1"
            fill={isCharging ? '#FFC857' : online ? '#3DDC97' : '#4A5160'}
          />
          <circle cx="24" cy="56" r="2" fill="var(--bg-primary)" />
          <circle cx="24" cy="56" r="1" fill={isCharging ? '#FFC857' : '#4A5160'} />

          {/* Battery icon */}
          <rect x="68" y="18" width="32" height="18" rx="3"
            fill="none"
            stroke={isCharging ? '#FFC857' : online ? '#3DDC97' : '#4A5160'}
            strokeWidth="2"
          />
          <rect x="100" y="23" width="3" height="8" rx="1"
            fill={isCharging ? '#FFC857' : online ? '#3DDC97' : '#4A5160'}
          />
          {/* Battery fill */}
          <rect x="71" y="21" width={((pct / 100) * 26)} height="12" rx="2"
            fill={isCharging ? '#FFC857' : online ? '#3DDC97' : '#4A5160'}
            opacity={isCharging ? '1' : '0.6'}
            className={isCharging ? 'chrg-batt' : ''}
          />

          {/* Energy flow dots (shown when charging) */}
          {isCharging && (
            <>
              <circle cx="40" cy="50" r="2" fill="#FFC857" className="chrg-dot d1" />
              <circle cx="34" cy="54" r="2" fill="#FFC857" className="chrg-dot d2" />
              <circle cx="28" cy="56" r="2" fill="#FFC857" className="chrg-dot d3" />
            </>
          )}
        </svg>

        {/* SoC percentage below SVG */}
        <div className="chgr-soc">
          {isCharging || activeTx ? (
            <span className="chgr-pct" style={{ color: isCharging ? 'var(--amber)' : 'var(--teal)' }}>
              {Math.round(pct)}%
            </span>
          ) : null}
        </div>
      </div>

      {/* Connector status chips */}
      <div className="chgr-conns">
        {(charger.connectors || []).map((con) => (
          <span key={con.connector_id} className={`chgr-conn-chip ${statusDotClass(con.status, con._meter)} ${offlineConnectors?.[`${charger.id}:${con.connector_id}`] ? 'dot-offline' : ''}`}>
            <span>{con.connector_id}</span>
            {con._meter?.eta_minutes != null && (
              <span className="chgr-conn-eta">~{formatMin(con._meter.eta_minutes)}</span>
            )}
          </span>
        ))}
      </div>

      {/* Footer: vendor + ETA / energy */}
      <div className="chgr-footer">
        <span className="chgr-vendor">{charger.vendor || '—'}</span>
        {isCharging && rateLabel && (
          <span className="chgr-rate">{rateLabel}</span>
        )}
        {isCharging && etaMinutes != null && (
          <span className="chgr-eta">~{formatMin(etaMinutes)}</span>
        )}
        {amountLabel && (
          <span key={amountLabel} className="chgr-amount">{amountLabel}</span>
        )}
        {activeTx && (
          <span className="chgr-energy">{(activeTx.energy_kwh || meter?.energy_kwh || 0).toFixed(1)} kWh</span>
        )}
        {!activeTx && meter?.energy_kwh != null && (
          <span className="chgr-energy">{(meter.energy_kwh || 0).toFixed(1)} kWh</span>
        )}
      </div>
    </div>
  );
}

function countStatuses(connectors) {
  const counts = { charging: 0, available: 0, faulted: 0, other: 0 };
  (connectors || []).forEach((c) => {
    const s = (c.status || '').toLowerCase();
    if (s === 'charging') counts.charging++;
    else if (s === 'available') counts.available++;
    else if (['faulted', 'error'].includes(s)) counts.faulted++;
    else counts.other++;
  });
  return counts;
}
