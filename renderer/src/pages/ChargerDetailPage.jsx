import { useParams, useNavigate } from 'react-router-dom';
import { useState, useRef, useEffect, useCallback } from 'react';
import { useChargers, useLiveEvents } from '../hooks/useVoltDesk';
import { useContextMenu } from '../hooks/useContextMenu.jsx';
import { sendAction, getSettings, searchCustomers, listLogs, listAttention, forceCloseSession, retryBilling } from '../services/ipc';
import { formatDuration, formatRate, formatCurrency, formatNullable, formatTimeAgo, statusColor } from '../utils';
import { CMD_RESULT_HIDE_MS, EVENT_LOG_LIMIT, SEARCH_DEBOUNCE_MS } from '../constants';
import {
  COMMAND_ACKNOWLEDGED, REMOTE_COMMAND_SENT, COMMAND_ACCEPTED, COMMAND_RESULT,
  commandSentText, commandQueuedText, commandRejectedText, failedToSendText,
  sessionClosedToast, sessionNeedsAttentionItem, FORCE_CLOSE_FAILED, FORCE_CLOSE_ERROR,
  BILLING_RETRY_FAILED, BILLING_RETRY_ERROR, billGeneratedText, billEventDetailText,
  connectorChargeCompleteText, connectorFaultText, attentionMessage,
  ATTENTION_HEADING, ATTENTION_BANNER_TITLE, FORCE_CLOSE_LABEL, FORCE_CLOSE_TITLE,
  CLOSE_SESSION_LABEL, CLOSING_LABEL, CANCEL_LABEL, RETRY_BILLING_LABEL,
  ATTENTION_MODAL_COPY, SENDING_LABEL, SELECT_CUSTOMER_FIRST, START_LABEL, STOP_LABEL,
  START_CHARGING, STOP_CHARGING, NO_ACTIONS_AVAILABLE, CHARGER_NOT_FOUND,
} from '../strings';

export default function ChargerDetailPage({ addToast, offlineConnectors }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const { openMenu } = useContextMenu();
  const { chargers, loading, refresh } = useChargers();
  const [acting, setActing] = useState(null);
  const [cmdResults, setCmdResults] = useState({});
  const cmdTimers = useRef({});
  const [customer, setCustomer] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [customerSearchEndpoint, setCustomerSearchEndpoint] = useState('');
  const searchTimer = useRef(null);
  const [eventLog, setEventLog] = useState([]);
  const [attention, setAttention] = useState([]);
  const [confirmClose, setConfirmClose] = useState(null);
  const [closing, setClosing] = useState(false);

  useLiveEvents({
    onChargerEvent: (evt) => {
      if (evt.type === 'command_result') {
        const key = `${evt.connector_id}_${evt.command}`;
        const ok = evt.status === 'Accepted' || evt.status === 'received';
        setCmdResults((prev) => ({ ...prev, [key]: { command: evt.command, status: evt.status, reason: evt.reason, ok, ts: Date.now() } }));
        if (evt.status === 'Accepted') addToast(COMMAND_ACCEPTED(evt.command, evt.charger_id, evt.connector_id), 'success');
        else if (evt.reason) addToast(commandRejectedText(evt.command, evt.reason), 'error');
        else addToast(COMMAND_RESULT(evt.command, evt.status), 'info');
        clearTimeout(cmdTimers.current[key]);
        cmdTimers.current[key] = setTimeout(() => {
          setCmdResults((prev) => { const n = { ...prev }; delete n[key]; return n; });
        }, CMD_RESULT_HIDE_MS);
      }
      if (evt.type === 'command_ack') {
        addToast(COMMAND_ACKNOWLEDGED(evt.command), 'info');
      }
      if (evt.type === 'command_sent') {
        addToast(REMOTE_COMMAND_SENT(evt.command), 'info');
      }
      if (evt.charger_id === id) {
        setEventLog((prev) => [{ ts: new Date().toISOString(), type: evt.type, payload: evt }, ...prev].slice(0, EVENT_LOG_LIMIT));
      }
      refresh();
      loadAttention();
    }
  });

  useEffect(() => {
    getSettings().then((s) => setCustomerSearchEndpoint(s.api_customer_search_endpoint || ''));
  }, []);

  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (!searchQuery.trim()) { setSearchResults([]); return; }
    searchTimer.current = setTimeout(async () => {
      setSearching(true);
      const results = await searchCustomers(searchQuery.trim());
      setSearchResults(results || []);
      setSearching(false);
    }, SEARCH_DEBOUNCE_MS);
    return () => { if (searchTimer.current) clearTimeout(searchTimer.current); };
  }, [searchQuery]);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const { rows } = await listLogs({ chargerId: id, limit: EVENT_LOG_LIMIT });
        if (mounted) setEventLog((rows || []).reverse().map((r) => ({ ts: r.ts || r.created_at, type: r.type, payload: r.payload ? (typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload) : {} })).slice(0, EVENT_LOG_LIMIT));
      } catch {}
    })();
    return () => { mounted = false; };
  }, [id]);

  const loadAttention = useCallback(async () => {
    try {
      const items = await listAttention();
      setAttention((items || []).filter((t) => t.charger_id === id));
    } catch {}
  }, [id]);

  useEffect(() => { loadAttention(); }, [loadAttention]);

  const charger = chargers.find((c) => c.id === id);

  const handleAction = async (connectorId, action) => {
    if (acting) return;
    setActing(`${connectorId}_${action}`);
    try {
      const payload = {
        charger_id: id,
        connector_id: connectorId,
        action,
      };
      if (action === 'START' && customer) {
        payload.customer = customer;
      }
      const result = await sendAction(payload);
      if (result.sent) {
        addToast(commandSentText(action, id, connectorId), 'info');
      } else if (result.queued) {
        addToast(commandQueuedText(action), 'info');
      } else {
        addToast(commandRejectedText(action, result.reason), 'error');
      }
    } catch (e) {
      addToast(failedToSendText(action, e.message), 'error');
    } finally {
      setActing(null);
      refresh();
    }
  };

  const handleForceClose = async (tx) => {
    setClosing(true);
    try {
      const result = await forceCloseSession(tx.id);
      if (result.success) {
        addToast(sessionClosedToast(tx), 'success');
      } else {
        addToast(FORCE_CLOSE_FAILED(result.reason), 'error');
      }
    } catch (e) {
      addToast(FORCE_CLOSE_ERROR(e.message), 'error');
    } finally {
      setClosing(false);
      setConfirmClose(null);
      refresh();
      loadAttention();
    }
  };

  const handleRetryBilling = async (tx) => {
    try {
      const result = await retryBilling(tx.id);
      if (result.success) {
        addToast(billGeneratedText(result.bill), 'success');
      } else {
        addToast(BILLING_RETRY_FAILED(result.reason), 'error');
      }
    } catch (e) {
      addToast(BILLING_RETRY_ERROR(e.message), 'error');
    } finally {
      refresh();
      loadAttention();
    }
  };

  if (loading) {
    return (
      <>
        <button className="back-btn" onClick={() => navigate('/chargers')}>Back to Chargers</button>
        <div className="view-header">
          <div className="skeleton" style={{ width: 200, height: 28, marginBottom: 8 }} />
          <div className="skeleton" style={{ width: 140, height: 16 }} />
        </div>
      {attention.length > 0 && (
        <div className="attention-list">
          <h2 className="attention-heading">{ATTENTION_HEADING}</h2>
          {attention.map((tx) => (
            <div key={tx.id} className="attention-item">
              <div className="attention-info">
                <strong>Connector {tx.connector_id}</strong>
                <span className="attention-reason">
                  {sessionNeedsAttentionItem(tx)}
                </span>
                {tx.energy_kwh != null && (
                  <span className="attention-meta">{(tx.energy_kwh || 0).toFixed(2)} kWh{tx.started_at ? ` \u00B7 started ${new Date(tx.started_at).toLocaleString()}` : ''}</span>
                )}
              </div>
              <div className="attention-actions">
                {tx.status === 'active' && (tx.customer_id || tx.customer_name) && (
                  <button className="btn danger" onClick={() => setConfirmClose(tx)}>
                    {FORCE_CLOSE_LABEL}
                  </button>
                )}
                {tx.status === 'stopped' && !tx.billed && (
                  <button className="btn ghost" onClick={() => handleRetryBilling(tx)}>
                    {RETRY_BILLING_LABEL}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="connector-grid">
          {[1,2].map((i) => (
            <div key={i} className="connector-card" style={{ padding: 16 }}>
              <div className="skeleton" style={{ width: '60%', height: 16, marginBottom: 8 }} />
              <div className="skeleton" style={{ width: '40%', height: 14, marginBottom: 16 }} />
              <div className="skeleton" style={{ width: '100%', height: 80, borderRadius: 8 }} />
            </div>
          ))}
        </div>
      </>
    );
  }

  if (!charger) {
    return (
      <>
        <button className="back-btn" onClick={() => navigate('/chargers')}>Back to Chargers</button>
        <div className="empty-state"><p>{CHARGER_NOT_FOUND}</p></div>
      </>
    );
  }

  const lastSeen = charger.last_seen
    ? formatTimeAgo(new Date(charger.last_seen).getTime())
    : 'never';

  return (
    <>
      <header className="view-header">
        <button className="back-btn" onClick={() => navigate('/chargers')}>Back to Chargers</button>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <h1 style={{ margin: 0 }}>{charger.id}</h1>
          <span className={`pill ${charger.online ? 'online' : 'offline'}`}>
            {charger.online ? 'Online' : 'Offline'}
          </span>
          <span style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: "'JetBrains Mono', monospace" }}>
            last seen: {lastSeen}
          </span>
        </div>
        <p className="muted">
          {charger.vendor || 'Unknown'} {charger.model ? `- ${charger.model}` : ''}
        </p>
      </header>

      {customerSearchEndpoint && (
        <div className="customer-search">
          <label style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4, display: 'block' }}>
            Select Customer
          </label>
          {customer ? (
            <div className="customer-tag">
              <span><strong>{customer.customer_name}</strong> ({customer.customer_id}){customer.customer_pan ? ` \u00B7 PAN: ${customer.customer_pan}` : ''}</span>
              <button className="btn-del" onClick={() => { setCustomer(null); setSearchQuery(''); setSearchResults([]); }}>\u00D7</button>
            </div>
          ) : (
            <>
              <input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search customer by name or ID..."
              />
              {searching && <span className="muted" style={{ fontSize: 11 }}>Searching...</span>}
              {searchResults.length > 0 && (
                <div className="customer-results">
                  {searchResults.map((c, i) => (
                    <div key={c.customer_id || i} className="customer-result" onClick={() => { setCustomer(c); setSearchQuery(''); setSearchResults([]); }}>
                      <strong>{c.customer_name}</strong> ({c.customer_id})
                      {c.customer_pan && <span className="muted"> \u00B7 PAN: {c.customer_pan}</span>}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}

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
          const statusRaw = (con.status || 'unknown').toLowerCase();
          const isCharging = statusRaw === 'charging';
          const liveStatus = isCharging ? 'charging' : statusRaw;
          const canStart = ['available', 'preparing'].includes(statusRaw);
          const canStop = !!activeTx;
          const rateMode = meter?.charging_rate_mode === 'kw' ? 'kw' : 'percentage';
          const rateLabel = rateMode === 'kw'
            ? formatRate(meter?.rateKw ?? meter?.rate_kw, 'kW')
            : formatRate(meter?.ratePerMin ?? meter?.rate_per_min, '%/min');
          const sessionEnergy = Number(session.energy ?? activeTx?.energy_kwh ?? meter?.energy_kwh ?? 0);
          const elapsedSec = Number(session.elapsed_sec ?? activeTx?.duration_sec ?? 0);
          const amountLabel = formatCurrency(meter?.total_amount);
          const tariffLabel = meter?.rate_per_kwh != null ? `$${Number(meter.rate_per_kwh).toFixed(2)}/kWh` : null;
          const sc = statusColor(liveStatus);
          const showMeterData = activeTx || meter;
          const powerNow = meterValues.power ?? meter?.power_kw;
          const powerDeltaKw = meter?.power_delta_kw ?? delta.power ?? null;
          const powerLabel = powerNow != null
            ? powerDeltaKw != null && Math.abs(powerDeltaKw) >= 0.005
              ? `${Number(powerNow).toFixed(2)} kW (\u0394 ${powerDeltaKw > 0 ? '+' : ''}${Number(powerDeltaKw).toFixed(2)})`
              : formatNullable(powerNow, 'kW')
            : '-';
          const hasLiveData = Number(meterValues.power ?? meter?.power_kw) > 0 || meterValues.voltage != null || meterValues.current != null || meter?.soc != null;
          const hasProgress = delta.soc != null || delta.energy != null || delta.power != null || rateLabel || meter?.eta_minutes != null || (session.soc_start != null && session.soc_end != null);

          const offlineKey = `${con.charger_id || id}:${con.connector_id}`;
          const isOffline = !!offlineConnectors?.[offlineKey];

          const openConnectorMenu = (e) => {
            const items = [];
            if (canStart) items.push({ label: START_CHARGING, run: () => handleAction(con.connector_id, 'START') });
            if (canStop) items.push({ label: STOP_CHARGING, danger: true, run: () => handleAction(con.connector_id, 'STOP') });
            if (items.length === 0) items.push({ label: NO_ACTIONS_AVAILABLE, disabled: true });
            openMenu(e, items);
          };

          return (
            <div key={con.connector_id} className={`connector-card ${isOffline ? 'offline' : liveStatus}`} onContextMenu={openConnectorMenu}>
              <div className="connector-header">
                <div className="battery-wrap">
                  <BatterySvg percent={Math.min(Math.max(Number(soc) || 0, 0), 100)} isCharging={isCharging && !isOffline} />
                  <div className="battery-soc">{Math.round(Math.min(Math.max(Number(soc) || 0, 0), 100))}%</div>
                </div>
                <div className="connector-info">
                  <div className="top-row">
                    <h3>Connector {con.connector_id}</h3>
                    {activeTx && <span className="tx-badge">Tx #{activeTx.ocpp_tx_id}</span>}
                  </div>
                  <div className={`status-badge dot-${isOffline ? 'faulted' : isCharging ? 'charging' : statusRaw === 'available' ? 'available' : statusRaw === 'faulted' || statusRaw === 'error' ? 'faulted' : 'other'}`}>
                    <span className="status-dot"></span>
                    <span style={{ color: isOffline ? 'var(--red)' : sc }}>
                      {isOffline ? 'OFFLINE' : liveStatus.toUpperCase()}
                      {!isOffline && con.error_code && con.error_code !== 'NoError' ? ` - ${con.error_code}` : ''}
                    </span>
                  </div>
                </div>
              </div>

              {showMeterData && (
                <div className="connector-sections">
{activeTx?.flagged && (activeTx.customer_id || activeTx.customer_name) && (
                    <div className="attention-banner">
                      <span className="attention-banner-title">{ATTENTION_BANNER_TITLE}</span>
                      <span>{attentionMessage(activeTx.flag_reason)}</span>
                    </div>
                  )}
                  <div className="connector-section-group">
                    <div className="section-group-label">Session</div>
                    <div className="section-group-metrics">
                      <Metric icon={<IconBolt />} label="Energy" value={`${sessionEnergy.toFixed(2)} kWh`} valueClass="blue" />
                      <Metric icon={<IconClock />} label="Duration" value={elapsedSec > 0 ? formatDuration(elapsedSec) : '-'} />
                      {tariffLabel && <Metric icon={<IconTag />} label="Tariff" value={tariffLabel} valueClass="teal" />}
                    </div>
                  </div>

                  {hasLiveData && (
                    <div className="connector-section-group">
                      <div className="section-group-label">Live</div>
                      <div className="section-group-metrics">
                        <Metric icon={<IconBolt />} label="Power" value={powerLabel} valueClass="amber" />
                        <Metric icon={<IconWave />} label="Voltage" value={formatNullable(meterValues.voltage, 'V')} />
                        <Metric icon={<IconCurrent />} label="Current" value={formatNullable(meterValues.current, 'A')} />
                        {meter?.soc != null && <Metric icon={<IconBattery />} label="SoC" value={`${Math.round(meter.soc)}%`} />}
                      </div>
                    </div>
                  )}

                  {hasProgress && (
                    <div className="connector-section-group">
                      <div className="section-group-label">Progress</div>
                      <div className="section-group-metrics">
                        {delta.soc != null && <Metric icon={<IconTrendUp />} label="SoC \u0394" value={formatNullable(delta.soc, '%')} />}
                        {delta.energy != null && <Metric icon={<IconTrendUp />} label="Energy \u0394" value={formatNullable(delta.energy, 'kWh')} />}
                        {powerDeltaKw != null && <Metric icon={<IconTrendUp />} label="Power \u0394" value={formatNullable(powerDeltaKw, 'kW')} />}
                        {session.soc_start != null && session.soc_end != null && (
                          <span className="connector-metric" style={{ color: 'var(--text-secondary)', fontFamily: "'JetBrains Mono', monospace", fontSize: 12 }}>
                            Session: {session.soc_start}% \u2192 {session.soc_end}%
                          </span>
                        )}
                      </div>
                      {(rateLabel || meter?.eta_minutes != null) && (
                        <div className="section-group-metrics" style={{ marginTop: 4 }}>
                          {rateLabel && <Metric icon={<IconSpeed />} label="Rate" value={rateLabel} valueClass="teal" />}
                          {meter?.eta_minutes != null && (
                            <Metric icon={<IconClock />} label="ETA" value={`~${formatDuration(meter.eta_minutes * 60)}`} valueClass="amber" />
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {amountLabel && (
                    <div className="connector-section-group">
                      <div className="section-group-label">Billing</div>
                      <div className="section-group-metrics">
                        <Metric icon={<IconDollar />} label="Amount" value={amountLabel} valueClass="amber" />
                        {meter?.shift_name && (
                          <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>({meter.shift_name})</span>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}

              <div className="connector-actions">
                {activeTx?.flagged && (
                  <button className="btn danger" disabled={acting !== null}
                    onClick={() => setConfirmClose(activeTx)}>
                    {FORCE_CLOSE_LABEL}
                  </button>
                )}
                {canStart && (
                  <button
                    className="btn primary"
                    disabled={acting === `${con.connector_id}_START` || (!!customerSearchEndpoint && !customer)}
                    onClick={() => handleAction(con.connector_id, 'START')}
                  >
                    {acting === `${con.connector_id}_START` ? SENDING_LABEL : customerSearchEndpoint && !customer ? SELECT_CUSTOMER_FIRST : START_LABEL}
                  </button>
                )}
                {canStop && (
                  <button
                    className="btn danger"
                    disabled={acting === `${con.connector_id}_STOP`}
                    onClick={() => handleAction(con.connector_id, 'STOP')}
                  >
                    {acting === `${con.connector_id}_STOP` ? SENDING_LABEL : STOP_LABEL}
                  </button>
                )}
                {!canStart && !canStop && (
                  <button className="btn ghost" disabled>{START_LABEL}</button>
                )}
              </div>
              {(() => {
                const startKey = `${con.connector_id}_START`;
                const stopKey = `${con.connector_id}_STOP`;
                const r = cmdResults[startKey] || cmdResults[stopKey];
                if (!r) return null;
                const ago = Math.floor((Date.now() - r.ts) / 1000);
                return (
                  <div className="cmd-result">
                    <span className={r.ok ? 'cmd-ok' : 'cmd-fail'}>
                      {r.ok ? '\u2713' : '\u2717'} {r.command} {r.status}{r.reason ? `: ${r.reason}` : ''}
                    </span>
                    <span className="cmd-ts">{ago}s ago</span>
                  </div>
                );
              })()}
            </div>
          );
        })}
      </div>

      {eventLog.length > 0 && (
        <div className="dash-section" style={{ marginTop: 20 }}>
          <h2>Recent Events</h2>
          <div className="event-timeline">
            {eventLog.slice(0, 15).map((e, i) => (
              <div key={i} className="event-row">
                <span className="event-ts">
                  {e.ts ? new Date(e.ts).toLocaleTimeString() : ''}
                </span>
                <span className={`event-type event-${eventTypeClass(e.type)}`}>
                  {e.type}
                </span>
                <span className="event-detail">
                  {eventDetail(e)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {confirmClose && (
        <div className="modal-backdrop open" onClick={() => !closing && setConfirmClose(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>{FORCE_CLOSE_TITLE}</h2>
            <p className="muted">
              {ATTENTION_MODAL_COPY}
            </p>
            <p className="muted">
              Connector {confirmClose.connector_id} \u00B7 Session {confirmClose.ocpp_tx_id || confirmClose.id}{' '}
              \u00B7 {confirmClose.energy_kwh != null ? `${(confirmClose.energy_kwh || 0).toFixed(2)} kWh` : 'energy unknown'}
            </p>
            <div className="modal-actions">
              <button className="btn danger" disabled={closing} onClick={() => handleForceClose(confirmClose)}>
                {closing ? CLOSING_LABEL : CLOSE_SESSION_LABEL}
              </button>
              <button className="btn ghost" disabled={closing} onClick={() => setConfirmClose(null)}>{CANCEL_LABEL}</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function eventTypeClass(type) {
  if (type === 'charge_complete' || type === 'bill_generated') return 'success';
  if (type === 'fault_alert' || type === 'bill_error' || type === 'command_rejected') return 'error';
  if (type === 'meter' || type === 'meter_eta') return 'info';
  return 'default';
}

function eventDetail(e) {
  const p = e.payload || {};
  if (e.type === 'status_transition') {
    const from = p.from || '';
    const to = p.to || '';
    return `Connector ${p.connector_id}: ${from} \u2192 ${to}${p.error ? ` (${p.error})` : ''}`;
  }
  if (e.type === 'charge_complete') {
    return connectorChargeCompleteText(p.connector_id);
  }
  if (e.type === 'fault_alert') {
    return connectorFaultText(p.connector_id, p.error);
  }
  if (e.type === 'bill_generated') {
    return billEventDetailText(p);
  }
  if (e.type === 'transaction_started') {
    return `Tx ${p.transaction_id} started on connector ${p.connector_id}`;
  }
  if (e.type === 'transaction_stopped') {
    return `Tx ${p.transaction_id} stopped on connector ${p.connector_id}`;
  }
  if (e.type === 'command_result') {
    return `${p.command} on conn ${p.connector_id}: ${p.status}${p.reason ? ' - ' + p.reason : ''}`;
  }
  return p.charger_id || p.connector_id != null ? `Connector ${p.connector_id}` : '';
}

function Metric({ icon, label, value, valueClass }) {
  return (
    <div className="connector-metric">
      {icon && <span className="metric-icon">{icon}</span>}
      <span className="metric-label">{label}</span>
      <strong className={`metric-value${valueClass ? ' ' + valueClass : ''}`}>{value}</strong>
    </div>
  );
}

function IconBolt() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>;
}
function IconBattery() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="1" y="6" width="18" height="12" rx="2"/><line x1="23" y1="10" x2="23" y2="14"/><line x1="7" y1="10" x2="7" y2="14"/><line x1="11" y1="10" x2="11" y2="14"/><line x1="15" y1="10" x2="15" y2="14"/></svg>;
}
function IconClock() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>;
}
function IconWave() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 14c2-2 4-4 6 0s4 4 6 0 4-4 6 0"/><path d="M2 10c2-2 4-4 6 0s4 4 6 0 4-4 6 0"/></svg>;
}
function IconCurrent() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2v20"/><path d="M8 6l4-4 4 4"/><path d="M8 18l4 4 4-4"/></svg>;
}
function IconTrendUp() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>;
}
function IconDollar() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>;
}
function IconTag() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>;
}
function IconSpeed() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2v4"/><path d="M12 18v4"/><path d="M4.93 4.93l2.83 2.83"/><path d="M16.24 16.24l2.83 2.83"/><path d="M2 12h4"/><path d="M18 12h4"/><path d="M6 12a6 6 0 0 1 12 0"/></svg>;
}

function batteryColor(pct) {
  if (pct <= 20) return '#FF5D5D';
  if (pct <= 40) return '#FFA94D';
  if (pct <= 60) return '#FFC857';
  if (pct <= 80) return '#3DDC97';
  return '#5AA9FF';
}

function BatterySvg({ percent, isCharging }) {
  const pct = Math.min(Math.max(percent, 0), 100);
  const color = batteryColor(pct);
  const fillH = (pct / 100) * 36;
  const fillY = 50 - fillH;

  return (
    <svg width="48" height="64" viewBox="0 0 48 64">
      <rect x="18" y="2" width="12" height="5" rx="1.5" fill={color} />
      <rect x="6" y="7" width="36" height="52" rx="5" fill="none" stroke={color} strokeWidth="2.5" />
      {pct > 0 && (
        <rect x="9" y={fillY} width="30" height={fillH} rx="3" fill={color} opacity="0.85"
          className={isCharging ? 'chrg-batt' : ''} />
      )}
    </svg>
  );
}

