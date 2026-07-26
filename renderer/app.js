const state = {
  chargers: [],
  selectedChargerId: null,
  bills: [],
  logs: [],
  shifts: [],
  settings: {}
};

// ---------------- View routing ----------------
function showView(name) {
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
  document.getElementById(`view-${name}`).classList.add('active');
  document.querySelectorAll('.nav-item').forEach((n) => n.classList.remove('active'));
  const navBtn = document.querySelector(`.nav-item[data-view="${name}"]`);
  if (navBtn) navBtn.classList.add('active');
}

document.querySelectorAll('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => {
    const view = btn.dataset.view;
    showView(view);
    if (view === 'billing') refreshBills();
    if (view === 'logs') refreshLogs();
    if (view === 'settings') refreshSettings();
  });
});

document.getElementById('backToChargers').addEventListener('click', () => showView('chargers'));

// ---------------- Ring gauge helper ----------------
function ringSvg(percent, statusClass, radius = 66) {
  const c = 2 * Math.PI * radius;
  const offset = c - (Math.min(Math.max(percent, 0), 100) / 100) * c;
  return `
    <svg width="150" height="150" viewBox="0 0 150 150">
      <circle class="ring-track" cx="75" cy="75" r="${radius}"></circle>
      <circle class="ring-fill ${statusClass}" cx="75" cy="75" r="${radius}"
        stroke-dasharray="${c}" stroke-dashoffset="${offset}"></circle>
    </svg>`;
}

const STARTABLE_STATUSES = new Set(['available', 'preparing']);

// One connector, one session at a time: Stop only shows once a session is
// actually active; Start only shows (and is enabled) while the connector is
// preparing/available with nothing running on it — no overlapping starts.
function renderConnectorAction(con, tx) {
  if (tx) {
    return `<button class="btn danger" data-stop="${con.connector_id}">Stop</button>`;
  }
  const startable = STARTABLE_STATUSES.has((con.status || '').toLowerCase());
  if (startable) {
    return `<button class="btn primary" data-start="${con.connector_id}">Start</button>`;
  }
  return `<button class="btn ghost" disabled title="Only startable while preparing or available">Start</button>`;
}

function statusClass(status) {
  const s = (status || '').toLowerCase();
  if (s === 'charging') return 'charging';
  if (s === 'available') return 'available';
  if (s === 'faulted') return 'faulted';
  if (s === 'preparing' || s === 'finishing') return 'preparing';
  return 'unavailable';
}

// ---------------- Chargers ----------------
async function refreshChargers() {
  state.chargers = await window.voltdesk.listChargers();
  renderChargerGrid();
  if (state.selectedChargerId) renderChargerDetail(state.selectedChargerId);
}

function renderChargerGrid() {
  const grid = document.getElementById('chargerGrid');
  if (state.chargers.length === 0) {
    grid.innerHTML = `<p class="muted">No chargers seen yet. Set the websocket URL in Settings.</p>`;
    return;
  }
  grid.innerHTML = state.chargers
    .map((c) => {
      const chips = c.connectors
        .map(
          (con) => `<div class="connector-chip">
            <span class="status-dot ${statusClass(con.status)}"></span>
            #${con.connector_id} ${con.status || '—'}
          </div>`
        )
        .join('');
      const eta = estimateEta(c);
      return `
        <div class="charger-card" data-charger="${c.id}">
          <div class="charger-card-head">
            <div>
              <div class="charger-card-id">${c.id}</div>
              <div class="charger-card-vendor">${c.vendor || 'Unknown'} · ${c.model || ''}</div>
            </div>
            <span class="pill ${c.online ? 'online' : 'offline'}">${c.online ? 'Online' : 'Offline'}</span>
          </div>
          <div class="connector-summary-row">${chips || '<span class="muted">No connectors yet</span>'}</div>
          ${eta ? `<div class="eta">Est. finish · ${eta}</div>` : ''}
        </div>`;
    })
    .join('');

  grid.querySelectorAll('.charger-card').forEach((card) => {
    card.addEventListener('click', () => {
      state.selectedChargerId = card.dataset.charger;
      document.getElementById('detailChargerId').textContent = state.selectedChargerId;
      renderChargerDetail(state.selectedChargerId);
      showView('charger-detail');
    });
  });
}

// Rough ETA: only meaningful once we have a live SoC trend; placeholder
// until meter deltas are streamed into charger state (see onEvent below).
function estimateEta(charger) {
  const tx = charger.active_transactions && charger.active_transactions[0];
  if (!tx || !tx._socRatePerMin || tx._soc == null) return null;
  const remaining = 100 - tx._soc;
  const mins = Math.max(1, Math.round(remaining / tx._socRatePerMin));
  return `~${mins} min`;
}

function renderChargerDetail(chargerId) {
  const charger = state.chargers.find((c) => c.id === chargerId);
  const grid = document.getElementById('connectorDetailGrid');
  if (!charger) {
    grid.innerHTML = '';
    return;
  }
  grid.innerHTML = charger.connectors
    .map((con) => {
      const tx = charger.active_transactions.find((t) => t.connector_id === con.connector_id);
      const isCharging = statusClass(con.status) === 'charging';
      const percent = tx && tx._soc != null ? tx._soc : isCharging ? 40 : 0;
      const centerVal = tx && tx._soc != null ? `${tx._soc}%` : con.status || '—';
      return `
        <div class="connector-card">
          <div class="ring-wrap">
            ${ringSvg(percent, statusClass(con.status))}
            <div class="ring-center">
              <div class="val">${centerVal}</div>
              <div class="lbl">Connector ${con.connector_id}</div>
            </div>
          </div>
          <div class="connector-meta">${con.status || 'unknown'}${con.error_code && con.error_code !== 'NoError' ? ' · ' + con.error_code : ''}</div>
          ${tx ? `<div class="connector-meta">${(tx._energy || 0).toFixed?.(2) ?? 0} kWh · tx #${tx.ocpp_tx_id}</div>` : ''}
          <div class="connector-actions">
            ${renderConnectorAction(con, tx)}
          </div>
        </div>`;
    })
    .join('');

  grid.querySelectorAll('[data-start]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      await window.voltdesk.sendAction({
        charger_id: chargerId,
        action: 'START',
        connector_id: Number(btn.dataset.start)
      });
      // Re-render from fresh state either way — a rejection just leaves
      // Start visible again, an acceptance flips to Stop once the CSMS
      // pushes the resulting status_transition.
      refreshChargers();
    })
  );
  grid.querySelectorAll('[data-stop]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      await window.voltdesk.sendAction({
        charger_id: chargerId,
        action: 'STOP',
        connector_id: Number(btn.dataset.stop)
      });
      refreshChargers();
    })
  );
}

// ---------------- Billing ----------------
async function refreshBills() {
  state.bills = await window.voltdesk.listBills({ limit: 100 });
  const list = document.getElementById('billList');
  if (state.bills.length === 0) {
    list.innerHTML = `<p class="muted">No invoices yet — they're generated automatically when a session stops.</p>`;
    return;
  }
  list.innerHTML = state.bills
    .map(
      (b) => `
      <div class="bill-row" data-bill="${b.id}">
        <div class="bill-num">${b.bill_number}</div>
        <div class="bill-total">${b.total.toFixed(2)}</div>
        <div class="bill-meta">${b.company_name} · ${(b.energy_kwh || 0).toFixed(2)} kWh · ${new Date(b.created_at).toLocaleString()}</div>
        <div class="print-counts">
          <span class="ok">✓ ${b.print_success_count}</span>
          <span class="fail">✕ ${b.print_fail_count}</span>
        </div>
      </div>`
    )
    .join('');
  list.querySelectorAll('.bill-row').forEach((row) =>
    row.addEventListener('click', () => openBillModal(Number(row.dataset.bill)))
  );
}

function openBillModal(billId) {
  const bill = state.bills.find((b) => b.id === billId);
  const backdrop = document.getElementById('billModalBackdrop');
  const modal = document.getElementById('billModal');
  modal.innerHTML = `
    <h3 style="font-family:var(--font-display); margin-top:0;">${bill.bill_number}</h3>
    <div class="field"><label>Total</label><div style="font-family:var(--font-mono); font-size:20px; color:var(--amber);">${bill.total.toFixed(2)}</div></div>
    <div class="field"><label>Energy</label><div>${(bill.energy_kwh || 0).toFixed(3)} kWh @ ${(bill.rate_per_kwh || 0).toFixed(2)}/kWh</div></div>
    ${bill.tax_amount ? `<div class="field"><label>Tax (${bill.tax_percent}%)</label><div>${bill.tax_amount.toFixed(2)}</div></div>` : ''}
    <div class="field"><label>Prints</label><div>${bill.print_success_count} succeeded · ${bill.print_fail_count} failed</div></div>
    <div class="connector-actions" style="margin-top:16px;">
      <button class="btn primary" id="printBtn">Print</button>
      <button class="btn ghost" id="closeModal">Close</button>
    </div>`;
  backdrop.classList.add('active');
  document.getElementById('closeModal').addEventListener('click', () => backdrop.classList.remove('active'));
  document.getElementById('printBtn').addEventListener('click', async () => {
    await window.voltdesk.printBill({ billId: bill.id });
    backdrop.classList.remove('active');
    refreshBills();
  });
}

// ---------------- Logs ----------------
async function refreshLogs() {
  state.logs = await window.voltdesk.listLogs({ limit: 300 });
  const table = document.getElementById('logTable');
  table.innerHTML = state.logs
    .map((l) => {
      let short = l.payload;
      try {
        short = JSON.stringify(JSON.parse(l.payload));
      } catch {}
      return `<div class="log-row">
        <span>${new Date(l.ts).toLocaleTimeString()}</span>
        <span class="log-charger">${l.charger_id || ''}</span>
        <span class="log-type">${l.type}</span>
        <span class="log-payload">${short}</span>
      </div>`;
    })
    .join('');
}

// ---------------- Settings ----------------
async function refreshSettings() {
  state.settings = await window.voltdesk.getSettings();
  state.shifts = await window.voltdesk.listShifts();
  const grid = document.getElementById('settingsGrid');
  const s = state.settings;

  grid.innerHTML = `
    <div class="settings-card">
      <h3>Connection</h3>
      <div class="field"><label>CSMS WebSocket URL</label>
        <input id="set_ws_url" placeholder="wss://your-server:6008" value="${s.ws_url || ''}"></div>
    </div>

    <div class="settings-card">
      <h3>Branding &amp; invoice</h3>
      <div class="field"><label>Company name</label><input id="set_company_name" value="${s.company_name || ''}"></div>
      <div class="field"><label>Bill prefix</label><input id="set_bill_prefix" value="${s.bill_prefix || ''}"></div>
      <div class="field"><label>Bill format</label>
        <select id="set_bill_format">
          <option value="thermal_80mm" ${s.bill_format === 'thermal_80mm' ? 'selected' : ''}>Thermal 80mm</option>
          <option value="a4" ${s.bill_format === 'a4' ? 'selected' : ''}>A4</option>
        </select></div>
    </div>

    <div class="settings-card">
      <h3>Backend sync</h3>
      <div class="field"><label>API base URL</label><input id="set_api_base_url" value="${s.api_base_url || ''}"></div>
      <div class="field"><label>Bills endpoint (path)</label><input id="set_api_endpoint_bills" placeholder="/api/bills" value="${s.api_endpoint_bills || ''}"></div>
      <div class="field"><label>Logs endpoint (path)</label><input id="set_api_endpoint_logs" placeholder="/api/logs" value="${s.api_endpoint_logs || ''}"></div>
      <div class="field"><label>Transactions endpoint (path)</label><input id="set_api_endpoint_transactions" placeholder="/api/transactions" value="${s.api_endpoint_transactions || ''}"></div>
      <div class="field"><label>API key</label><input id="set_api_key" type="password" value="${s.api_key || ''}"></div>
    </div>

    <div class="settings-card" style="grid-column: span 2;">
      <h3>Shifts &amp; tax</h3>
      <div id="shiftRows"></div>
      <button class="btn ghost" id="addShiftBtn" style="margin-top:8px;">+ Add shift</button>
    </div>

    <div class="settings-card">
      <button class="btn primary" id="saveSettingsBtn">Save settings</button>
    </div>
  `;

  renderShiftRows();
  document.getElementById('addShiftBtn').addEventListener('click', () => {
    state.shifts.push({ name: '', start_time: '00:00', end_time: '00:00', rate_per_kwh: 0, tax_applicable: 0, tax_percent: 0, active: 1, _new: true });
    renderShiftRows();
  });
  document.getElementById('saveSettingsBtn').addEventListener('click', saveAllSettings);
}

function renderShiftRows() {
  const container = document.getElementById('shiftRows');
  container.innerHTML =
    `<div class="shift-row" style="color:var(--muted);"><span>Name</span><span>Start</span><span>End</span><span>Rate</span><span>Tax</span><span></span></div>` +
    state.shifts
      .map(
        (sh, i) => `
      <div class="shift-row" data-idx="${i}">
        <input class="sf-name" value="${sh.name || ''}" placeholder="Day">
        <input class="sf-start" type="time" value="${sh.start_time || '00:00'}">
        <input class="sf-end" type="time" value="${sh.end_time || '00:00'}">
        <input class="sf-rate" type="number" step="0.01" value="${sh.rate_per_kwh || 0}">
        <input class="sf-tax" type="number" step="0.1" value="${sh.tax_percent || 0}" title="Tax % (0 = no tax)">
        <button class="btn danger" data-del="${i}" style="padding:6px 8px;">✕</button>
      </div>`
      )
      .join('');

  container.querySelectorAll('[data-del]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const idx = Number(btn.dataset.del);
      const shift = state.shifts[idx];
      if (shift.id) await window.voltdesk.deleteShift(shift.id);
      state.shifts.splice(idx, 1);
      renderShiftRows();
    })
  );
}

async function saveAllSettings() {
  const patch = {
    ws_url: val('set_ws_url'),
    company_name: val('set_company_name'),
    bill_prefix: val('set_bill_prefix'),
    bill_format: val('set_bill_format'),
    api_base_url: val('set_api_base_url'),
    api_endpoint_bills: val('set_api_endpoint_bills'),
    api_endpoint_logs: val('set_api_endpoint_logs'),
    api_endpoint_transactions: val('set_api_endpoint_transactions'),
    api_key: val('set_api_key')
  };
  await window.voltdesk.setSettings(patch);

  const rows = document.querySelectorAll('#shiftRows .shift-row[data-idx]');
  for (const row of rows) {
    const idx = Number(row.dataset.idx);
    const sh = state.shifts[idx];
    const payload = {
      id: sh.id,
      name: row.querySelector('.sf-name').value,
      start_time: row.querySelector('.sf-start').value,
      end_time: row.querySelector('.sf-end').value,
      rate_per_kwh: parseFloat(row.querySelector('.sf-rate').value) || 0,
      tax_percent: parseFloat(row.querySelector('.sf-tax').value) || 0,
      tax_applicable: parseFloat(row.querySelector('.sf-tax').value) > 0 ? 1 : 0,
      active: 1
    };
    await window.voltdesk.upsertShift(payload);
  }
  refreshSettings();
}

function val(id) {
  return document.getElementById(id).value;
}

// ---------------- Live events ----------------
window.voltdesk.onEvent((evt) => {
  if (evt.type === 'connection_status') {
    const led = document.querySelector('.conn-led');
    const label = document.getElementById('connLabel');
    led.classList.toggle('on', evt.status === 'connected');
    label.textContent = evt.status === 'connected' ? evt.url : 'Reconnecting…';
    return;
  }
  // Any charger-affecting event: refresh from the source of truth (SQLite via IPC).
  // Debounced lightly by only refreshing chargers view data structures.
  refreshChargers();
  if (document.getElementById('view-billing').classList.contains('active')) refreshBills();
  if (document.getElementById('view-logs').classList.contains('active')) refreshLogs();
});

// ---------------- Init ----------------
refreshChargers();
setInterval(refreshChargers, 5000); // safety-net poll alongside push events
