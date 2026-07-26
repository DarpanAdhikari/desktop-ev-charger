const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const db = require('./db/db');
const { CsmsClient } = require('./services/wsClient');
const syncWorker = require('./services/syncWorker');
const { printBill } = require('./services/printService');
const { renderBillHtml } = require('./services/billTemplate');
const { validateWsUrl } = require('./utils');

let mainWindow;
let csms;
let connectionState = { connected: false, connecting: false, url: '', error: null };

function broadcast(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function updateConnectionState(evt) {
  if (evt.type !== 'connection_status') return;
  connectionState = {
    connected: evt.status === 'connected',
    connecting: evt.status === 'connecting',
    url: evt.url || connectionState.url || '',
    error: evt.status === 'error' ? evt.error || 'Connection error' : null
  };
}

function emitCsmsEvent(evt) {
  updateConnectionState(evt);
  broadcast('csms:event', evt);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1040,
    minHeight: 680,
    backgroundColor: '#0E1116',
    icon: path.join(__dirname, '..', 'assets', 'logo', 'logo.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'dist', 'index.html'));
  }
}

function tryConnectWs(url) {
  const err = validateWsUrl(url);
  if (err) {
    console.error('[ws]', err.message);
    emitCsmsEvent({
      type: 'connection_status',
      status: 'error',
      url,
      error: err.message
    });
    return false;
  }
  emitCsmsEvent({
    type: 'connection_status',
    status: 'connecting',
    url
  });
  const settings = db.getSettings();
  const skipSslVerify = settings.skip_ssl_verify === '1';
  csms.configure({
    chargingRateMode: settings.charging_rate_mode,
    defaultBatteryCapacityKwh: settings.default_battery_capacity_kwh
  });
  csms.connect(url, { skipSslVerify });
  return true;
}

async function checkHealth(settings) {
  const base = settings.api_base_url;
  const path = settings.api_health_endpoint;
  if (!base || !path) return { ok: false, reason: 'not_configured' };
  const url = base.replace(/\/$/, '') + path;
  const start = Date.now();
  try {
    const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(5000) });
    return { ok: res.ok, status: res.status, latency: Date.now() - start };
  } catch (err) {
    return { ok: false, reason: err.message, latency: Date.now() - start };
  }
}

app.whenReady().then(() => {
  db.init();
  const startupSettings = db.getSettings();
  csms = new CsmsClient((evt) => emitCsmsEvent(evt), {
    chargingRateMode: startupSettings.charging_rate_mode,
    defaultBatteryCapacityKwh: startupSettings.default_battery_capacity_kwh
  });

  if (startupSettings.ws_url) tryConnectWs(startupSettings.ws_url);

  syncWorker.start();
  createWindow();

  // Startup health check
  checkHealth(startupSettings).then((result) => {
    broadcast('csms:event', { type: 'health_status', ...result });
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  syncWorker.stop();
  if (csms) csms.disconnect();
  if (process.platform !== 'darwin') app.quit();
});

// ---------------- IPC surface exposed to the renderer via preload ----------------

ipcMain.handle('settings:get', () => db.getSettings());
ipcMain.handle('connection:getStatus', () => connectionState);

ipcMain.handle('settings:set', (_e, patch) => {
  const previous = db.getSettings();
  const updated = db.setSettings(patch);
  if (patch.charging_rate_mode != null || patch.default_battery_capacity_kwh != null) {
    csms.configure({
      chargingRateMode: updated.charging_rate_mode,
      defaultBatteryCapacityKwh: updated.default_battery_capacity_kwh
    });
  }
  const wsUrlChanged = patch.ws_url != null && (patch.ws_url || '') !== (previous.ws_url || '');
  const sslChanged = patch.skip_ssl_verify != null && (patch.skip_ssl_verify || '0') !== (previous.skip_ssl_verify || '0');
  if (wsUrlChanged || (sslChanged && updated.ws_url)) {
    csms.disconnect();
    if (updated.ws_url) {
      tryConnectWs(updated.ws_url);
    } else {
      connectionState = { connected: false, connecting: false, url: '', error: null };
      emitCsmsEvent({ type: 'connection_status', status: 'disconnected', url: '' });
    }
  }
  return updated;
});

ipcMain.handle('app:reset', (_e, { pin } = {}) => {
  const settings = db.getSettings();
  if (!settings.pin_code) return { success: false, reason: 'pin_not_configured' };
  if (!pin || pin !== settings.pin_code) return { success: false, reason: 'invalid_pin' };
  if (csms) {
    csms.disconnect();
    csms.clearLiveState();
  }
  connectionState = { connected: false, connecting: false, url: '', error: null };
  const updated = db.resetAppData();
  emitCsmsEvent({ type: 'connection_status', status: 'disconnected', url: '' });
  return { success: true, settings: updated };
});

ipcMain.handle('shifts:list', () =>
  db.raw.prepare('SELECT * FROM shifts ORDER BY start_time').all()
);

ipcMain.handle('shifts:upsert', (_e, shift) => {
  const raw = db.raw;
  const normalized = normalizeShift(shift);
  if (normalized.id) {
    raw
      .prepare(
        `UPDATE shifts SET name=@name, start_time=@start_time, end_time=@end_time,
           rate_per_kwh=@rate_per_kwh, tax_applicable=@tax_applicable,
           tax_percent=@tax_percent, active=@active WHERE id=@id`
      )
      .run(normalized);
  } else {
    raw
      .prepare(
        `INSERT INTO shifts (name, start_time, end_time, rate_per_kwh, tax_applicable, tax_percent, active)
         VALUES (@name, @start_time, @end_time, @rate_per_kwh, @tax_applicable, @tax_percent, @active)`
      )
      .run(normalized);
  }
  return raw.prepare('SELECT * FROM shifts ORDER BY start_time').all();
});

ipcMain.handle('shifts:delete', (_e, id) => {
  db.raw.prepare('DELETE FROM shifts WHERE id = ?').run(id);
  return db.raw.prepare('SELECT * FROM shifts ORDER BY start_time').all();
});

function normalizeShift(shift) {
  return {
    id: shift.id ?? null,
    name: shift.name || 'Shift',
    start_time: shift.start_time || '00:00',
    end_time: shift.end_time || '23:59',
    rate_per_kwh: Number.isFinite(Number(shift.rate_per_kwh)) ? Number(shift.rate_per_kwh) : 0,
    tax_applicable: shift.tax_applicable === true || shift.tax_applicable === 1 || shift.tax_applicable === '1' ? 1 : 0,
    tax_percent: Number.isFinite(Number(shift.tax_percent)) ? Number(shift.tax_percent) : 0,
    active: shift.active === false || shift.active === 0 || shift.active === '0' ? 0 : 1
  };
}

ipcMain.handle('chargers:list', () => {
  const raw = db.raw;
  const chargers = raw.prepare('SELECT * FROM chargers ORDER BY id').all();
  return chargers.map((c) => ({
    ...c,
    connectors: raw
      .prepare('SELECT * FROM connectors WHERE charger_id = ? ORDER BY connector_id')
      .all(c.id)
      .map((con) => {
        const meter = csms ? csms.getMeterData(c.id, con.connector_id) : null;
        return { ...con, _meter: meter || null };
      }),
    active_transactions: raw
      .prepare(`SELECT * FROM transactions WHERE charger_id = ? AND status = 'active'`)
      .all(c.id)
  }));
});

ipcMain.handle('logs:list', (_e, { chargerId, limit } = {}) => {
  const raw = db.raw;
  if (chargerId) {
    return raw
      .prepare('SELECT * FROM logs WHERE charger_id = ? ORDER BY id DESC LIMIT ?')
      .all(chargerId, limit || 200);
  }
  return raw.prepare('SELECT * FROM logs ORDER BY id DESC LIMIT ?').all(limit || 200);
});

ipcMain.handle('bills:list', (_e, { limit } = {}) =>
  db.raw
    .prepare('SELECT * FROM bills ORDER BY id DESC LIMIT ?')
    .all(limit || 100)
);

ipcMain.handle('bills:print', async (_e, { billId, deviceName }) => {
  const raw = db.raw;
  const bill = raw.prepare('SELECT * FROM bills WHERE id = ?').get(billId);
  const tx = raw.prepare('SELECT * FROM transactions WHERE id = ?').get(bill.transaction_id);
  const settings = db.getSettings();
  const html = renderBillHtml(bill, tx, settings);
  const result = await printBill(bill, html, deviceName);
  return { ...result, bill: raw.prepare('SELECT * FROM bills WHERE id = ?').get(billId) };
});

ipcMain.handle('health:check', async () => {
  return await checkHealth(db.getSettings());
});

ipcMain.handle('printers:list', async () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    return await mainWindow.webContents.getPrintersAsync();
  }
  return [];
});

// ── Transactions history ──
ipcMain.handle('transactions:list', (_e, { fromDate, toDate, limit } = {}) => {
  const raw = db.raw;
  let sql = 'SELECT * FROM transactions WHERE 1=1';
  const params = [];
  if (fromDate) { sql += ' AND started_at >= ?'; params.push(fromDate); }
  if (toDate) { sql += ' AND started_at <= ?'; params.push(toDate); }
  sql += ' ORDER BY id DESC';
  if (limit) { sql += ' LIMIT ?'; params.push(limit); }
  return raw.prepare(sql).all(...params);
});

ipcMain.handle('transactions:stats', (_e, { fromDate, toDate } = {}) => {
  const raw = db.raw;
  let sql = 'SELECT COUNT(*) as count, COALESCE(SUM(energy_kwh),0) as total_energy FROM transactions WHERE 1=1';
  const params = [];
  if (fromDate) { sql += ' AND started_at >= ?'; params.push(fromDate); }
  if (toDate) { sql += ' AND started_at <= ?'; params.push(toDate); }
  return raw.prepare(sql).get(...params);
});

ipcMain.handle('transactions:daily', (_e, { fromDate, toDate } = {}) => {
  const raw = db.raw;
  let sql = `SELECT DATE(started_at) as day, COUNT(*) as count, COALESCE(SUM(energy_kwh),0) as energy FROM transactions WHERE status='stopped'`;
  const params = [];
  if (fromDate) { sql += ' AND started_at >= ?'; params.push(fromDate); }
  if (toDate) { sql += ' AND started_at <= ?'; params.push(toDate); }
  sql += ' GROUP BY DATE(started_at) ORDER BY day ASC';
  return raw.prepare(sql).all(...params);
});

// ── CSV export ──
ipcMain.handle('export:csv', async (_e, { data, filename, columns }) => {
  if (!mainWindow || mainWindow.isDestroyed()) return { success: false, reason: 'no_window' };
  const { filePath, canceled } = await dialog.showSaveDialog(mainWindow, {
    defaultPath: filename || 'export.csv',
    filters: [{ name: 'CSV', extensions: ['csv'] }]
  });
  if (canceled || !filePath) return { success: false, reason: 'canceled' };
  try {
    const header = columns.map((c) => `"${c}"`).join(',');
    const rows = data.map((row) =>
      columns.map((c) => {
        const v = row[c] != null ? String(row[c]).replace(/"/g, '""') : '';
        return `"${v}"`;
      }).join(',')
    );
    fs.writeFileSync(filePath, '\uFEFF' + header + '\n' + rows.join('\n'), 'utf8');
    return { success: true, path: filePath };
  } catch (err) {
    return { success: false, reason: err.message };
  }
});

// ── Database backup / restore ──
ipcMain.handle('db:backup', async () => {
  if (!mainWindow || mainWindow.isDestroyed()) return { success: false, reason: 'no_window' };
  const { filePath, canceled } = await dialog.showSaveDialog(mainWindow, {
    defaultPath: `voltdesk-backup-${Date.now()}.db`,
    filters: [{ name: 'SQLite DB', extensions: ['db'] }]
  });
  if (canceled || !filePath) return { success: false, reason: 'canceled' };
  try {
    db.raw.backup(filePath);
    return { success: true, path: filePath };
  } catch (err) {
    return { success: false, reason: err.message };
  }
});

ipcMain.handle('db:restore', async () => {
  if (!mainWindow || mainWindow.isDestroyed()) return { success: false, reason: 'no_window' };
  const { filePaths, canceled } = await dialog.showOpenDialog(mainWindow, {
    filters: [{ name: 'SQLite DB', extensions: ['db'] }],
    properties: ['openFile']
  });
  if (canceled || filePaths.length === 0) return { success: false, reason: 'canceled' };
  try {
    const restorePath = filePaths[0];
    const userDataPath = app.getPath('userData');
    const targetPath = path.join(userDataPath, 'voltdesk.db');
    // Backup current db, close it, replace file, re-init
    fs.copyFileSync(targetPath, targetPath + '.pre-restore');
    db.init(); // close old + re-init from existing file (will re-read from targetPath)
    fs.copyFileSync(restorePath, targetPath);
    db.init(); // re-init from restored file
    // Re-fetch settings and reconnect WS if needed
    const settings = db.getSettings();
    if (settings.ws_url) {
      if (csms) csms.disconnect();
      tryConnectWs(settings.ws_url);
    }
    return { success: true };
  } catch (err) {
    return { success: false, reason: err.message };
  }
});

const STARTABLE_STATUSES = new Set(['available', 'preparing']);

function canStartConnector(chargerId, connectorId) {
  const raw = db.raw;
  const con = raw
    .prepare('SELECT * FROM connectors WHERE charger_id = ? AND connector_id = ?')
    .get(chargerId, connectorId);
  if (!con) return { ok: false, reason: 'unknown_connector' };
  if (!STARTABLE_STATUSES.has((con.status || '').toLowerCase())) {
    return { ok: false, reason: `connector_${con.status}` };
  }
  const activeTx = raw
    .prepare(
      `SELECT id FROM transactions WHERE charger_id = ? AND connector_id = ? AND status = 'active'`
    )
    .get(chargerId, connectorId);
  if (activeTx) return { ok: false, reason: 'transaction_active' };
  return { ok: true };
}

ipcMain.handle('csms:action', (_e, actionPayload) => {
  const { charger_id: chargerId, connector_id: connectorId, action } = actionPayload;

  if (action === 'START') {
    // Hard guard: only fire START when the connector is preparing/available
    // and has no active session — prevents overlapping/duplicate starts even
    // if the UI is double-clicked or two windows race each other.
    const check = canStartConnector(chargerId, connectorId);
    if (!check.ok) {
      broadcast('csms:event', {
        type: 'command_result',
        command: 'START',
        charger_id: chargerId,
        connector_id: connectorId,
        status: 'rejected',
        reason: check.reason
      });
      return { sent: false, reason: check.reason };
    }
  }

  if (action === 'STOP') {
    // Only meaningful if there's actually an active transaction to stop.
    const raw = db.raw;
    const activeTx = raw
      .prepare(
        `SELECT id FROM transactions WHERE charger_id = ? AND connector_id = ? AND status = 'active'`
      )
      .get(chargerId, connectorId);
    if (!activeTx) {
      broadcast('csms:event', {
        type: 'command_result',
        command: 'STOP',
        charger_id: chargerId,
        connector_id: connectorId,
        status: 'rejected',
        reason: 'no_active_transaction'
      });
      return { sent: false, reason: 'no_active_transaction' };
    }
  }

  csms.send(actionPayload);
  return { sent: true };
});
