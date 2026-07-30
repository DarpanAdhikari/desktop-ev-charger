const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const db = require('./db/db');
const { CsmsClient } = require('./services/wsClient');
const syncWorker = require('./services/syncWorker');
const { printBill } = require('./services/printService');
const { renderBillHtml, setCachedTemplate } = require('./services/billTemplate');
const escposPrinter = require('./services/escposPrinter');
const bluetoothPrinter = require('./services/bluetoothPrinter');
const { validateWsUrl } = require('./utils');

let mainWindow;
let csms;
let connectionState = { connected: false, connecting: false, url: '', error: null };
const pendingCustomers = new Map(); // "chargerId:connectorId" -> customer object

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
    defaultBatteryCapacityKwh: startupSettings.default_battery_capacity_kwh,
    pendingCustomers
  });

  if (startupSettings.ws_url) tryConnectWs(startupSettings.ws_url);

  syncWorker.start();
  createWindow();

  // Startup health check
  checkHealth(startupSettings).then((result) => {
    broadcast('csms:event', { type: 'health_status', ...result });
  });

  bluetoothPrinter.registerBluetoothHandlers();
  if (startupSettings.bt_printer_address) {
    bluetoothPrinter.reconnectBluetoothPrinter(startupSettings.bt_printer_address);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  syncWorker.stop();
  if (csms) csms.disconnect();
  bluetoothPrinter.cleanupBluetoothDaemons();
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

ipcMain.handle('logs:list', (_e, { chargerId, limit, offset } = {}) => {
  const raw = db.raw;
  const lim = limit || 50;
  const off = offset || 0;
  if (chargerId) {
    const { count } = raw.prepare("SELECT COUNT(*) as count FROM logs WHERE charger_id = ?").get(chargerId);
    const rows = raw
      .prepare('SELECT * FROM logs WHERE charger_id = ? ORDER BY id DESC LIMIT ? OFFSET ?')
      .all(chargerId, lim, off);
    return { rows, total: count };
  }
  const { count } = raw.prepare("SELECT COUNT(*) as count FROM logs").get();
  const rows = raw.prepare('SELECT * FROM logs ORDER BY id DESC LIMIT ? OFFSET ?').all(lim, off);
  return { rows, total: count };
});

ipcMain.handle('bills:list', (_e, { limit } = {}) =>
  db.raw
    .prepare('SELECT * FROM bills ORDER BY id DESC LIMIT ?')
    .all(limit || 100)
);

ipcMain.handle('bills:print', async (_e, { billId, deviceName } = {}) => {
  const raw = db.raw;
  const bill = raw.prepare('SELECT * FROM bills WHERE id = ?').get(billId);
  if (!bill) return { success: false, reason: 'bill_not_found' };
  const tx = raw.prepare('SELECT * FROM transactions WHERE id = ?').get(bill.transaction_id);
  const settings = db.getSettings();
  const printerType = settings.printer_type || 'system';
  const displayFormat = settings.bill_display_format || 'professional';
  try {
    let result;
    if (printerType === 'network') {
      const ip = settings.printer_network_ip;
      const port = parseInt(settings.printer_network_port || '9100', 10);
      if (!ip) return { success: false, reason: 'Network printer IP not configured' };
      if ((settings.thermal_print_mode || 'raster') === 'text') {
        result = await escposPrinter.printTextToNetwork(bill, tx, settings, ip, port);
      } else {
        const html = renderBillHtml(bill, tx, settings, displayFormat);
        const dots = escposPrinter.targetDotsFromPaperWidth(settings.paper_width);
        result = await escposPrinter.printImageToNetwork(html, ip, port, dots);
      }
    } else if (printerType === 'bluetooth') {
      const addr = settings.bt_printer_address;
      if (!addr) return { success: false, reason: 'Bluetooth printer not configured' };
      if ((settings.thermal_print_mode || 'raster') === 'text') {
        result = await escposPrinter.printTextToBluetooth(bill, tx, settings, addr);
      } else {
        const html = renderBillHtml(bill, tx, settings, displayFormat);
        const dots = escposPrinter.targetDotsFromPaperWidth(settings.paper_width);
        result = await escposPrinter.printImageToBluetooth(html, addr, dots);
      }
    } else {
      // System/A4 printer: full-page HTML printing
      const html = renderBillHtml(bill, tx, settings, displayFormat);
      result = await printBill(bill, html, deviceName);
    }
    return { ...result, bill: raw.prepare('SELECT * FROM bills WHERE id = ?').get(billId) };
  } catch (err) {
    return { success: false, failureReason: err.message };
  }
});

ipcMain.handle('bill:generatePdf', async (_e, arg) => {
  const billId = (typeof arg === 'object' ? arg.billId : arg);
  const raw = db.raw;
  const bill = raw.prepare('SELECT * FROM bills WHERE id = ?').get(billId);
  if (!bill) return { success: false, reason: 'bill_not_found' };
  const tx = raw.prepare('SELECT * FROM transactions WHERE id = ?').get(bill.transaction_id);
  const settings = db.getSettings();
  const html = renderBillHtml(bill, tx, settings, settings.bill_display_format || 'professional');
  const pdfWin = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true }
  });
  try {
    await pdfWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    await pdfWin.webContents.executeJavaScript('document.fonts.ready');
    const pdfBuffer = await pdfWin.webContents.printToPDF({
      printBackground: true,
      margins: { top: 0.4, bottom: 0.4, left: 0.4, right: 0.4 }
    });
    return { success: true, data: pdfBuffer.toString('base64'), name: `${bill.bill_number}.pdf` };
  } catch (err) {
    return { success: false, reason: err.message };
  } finally {
    pdfWin.close();
  }
});

ipcMain.handle('bill:previewHtml', async (_e, arg) => {
  const billId = (typeof arg === 'object' ? arg.billId : arg);
  const raw = db.raw;
  const bill = raw.prepare('SELECT * FROM bills WHERE id = ?').get(billId);
  if (!bill) return { html: null, bill_number: null };
  const tx = raw.prepare('SELECT * FROM transactions WHERE id = ?').get(bill.transaction_id);
  const settings = db.getSettings();
  const html = renderBillHtml(bill, tx, settings, settings.bill_display_format || 'professional', false);
  return { html, bill_number: bill.bill_number };
});

ipcMain.handle('bill:generateImage', async (_e, arg) => {
  const billId = (typeof arg === 'object' ? arg.billId : arg);
  const raw = db.raw;
  const bill = raw.prepare('SELECT * FROM bills WHERE id = ?').get(billId);
  if (!bill) return { success: false, reason: 'bill_not_found' };
  const tx = raw.prepare('SELECT * FROM transactions WHERE id = ?').get(bill.transaction_id);
  const settings = db.getSettings();
  const html = renderBillHtml(bill, tx, settings, settings.bill_display_format || 'professional');
  const imgWin = new BrowserWindow({
    show: false, width: 800, height: 800,
    webPreferences: { contextIsolation: true }
  });
  try {
    await imgWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    await imgWin.webContents.executeJavaScript('document.fonts.ready');
    const { width, height } = await imgWin.webContents.executeJavaScript(
      `({ width: document.body.scrollWidth,
          height: Math.max(document.body.scrollHeight, document.documentElement.scrollHeight) })`
    );
    imgWin.setContentBounds({ x: 0, y: 0, width: Math.ceil(width) + 2, height: Math.min(Math.ceil(height), 3000) });
    await new Promise((r) => setTimeout(r, 150));
    const image = await imgWin.webContents.capturePage();
    const pngBuffer = image.toPNG();
    return { success: true, data: pngBuffer.toString('base64'), name: `${bill.bill_number}.png` };
  } catch (err) {
    return { success: false, reason: err.message };
  } finally {
    imgWin.close();
  }
});

ipcMain.handle('health:check', async () => {
  return await checkHealth(db.getSettings());
});

ipcMain.handle('image:pick', async () => {
  if (!mainWindow || mainWindow.isDestroyed()) return { canceled: true };
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }]
  });
  if (result.canceled || !result.filePaths.length) return { canceled: true };
  const filePath = result.filePaths[0];
  const ext = path.extname(filePath).slice(1);
  const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
  const data = fs.readFileSync(filePath).toString('base64');
  return { canceled: false, data: `data:${mime};base64,${data}`, name: path.basename(filePath) };
});

ipcMain.handle('customer:search', async (_e, query) => {
  const settings = db.getSettings();
  const base = settings.api_base_url;
  const path = settings.api_customer_search_endpoint;
  if (!base || !path || !query) return [];
  try {
    const url = base.replace(/\/$/, '') + path + '?q=' + encodeURIComponent(query);
    const res = await fetch(url, {
      headers: settings.api_key ? { Authorization: `Bearer ${settings.api_key}` } : {}
    });
    if (!res.ok) return [];
    return await res.json();
  } catch { return []; }
});

async function urlToBase64(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return '';
    const buf = Buffer.from(await res.arrayBuffer());
    const ext = url.split('.').pop().split('?')[0]?.toLowerCase() || 'png';
    const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/png';
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch { return ''; }
}

ipcMain.handle('company:info', async () => {
  const settings = db.getSettings();
  const base = settings.api_base_url;
  const path = settings.api_company_info_endpoint;
  if (!base || !path) return null;
  try {
    const url = base.replace(/\/$/, '') + path;
    const res = await fetch(url, {
      headers: settings.api_key ? { Authorization: `Bearer ${settings.api_key}` } : {}
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.branding_logo && !data.branding_logo.startsWith('data:')) data.branding_logo = await urlToBase64(data.branding_logo);
    if (data.invoice_logo && !data.invoice_logo.startsWith('data:')) data.invoice_logo = await urlToBase64(data.invoice_logo);
    return data;
  } catch { return null; }
});

ipcMain.handle('bill:fetchTemplate', async () => {
  const settings = db.getSettings();
  const base = settings.api_base_url;
  const path = settings.api_bill_format_endpoint;
  if (!base || !path) return null;
  try {
    const url = base.replace(/\/$/, '') + path;
    const res = await fetch(url, {
      headers: settings.api_key ? { Authorization: `Bearer ${settings.api_key}` } : {}
    });
    if (!res.ok) return null;
    const html = await res.text();
    setCachedTemplate(html);
    return html;
  } catch { return null; }
});

ipcMain.handle('printers:list', async () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    return await mainWindow.webContents.getPrintersAsync();
  }
  return [];
});

ipcMain.handle('printers:listCom', async () => {
  return escposPrinter.listComPorts();
});

ipcMain.handle('printers:test', async (_e, { printerType, ip, port, comName } = {}) => {
  const settings = db.getSettings();
  const type = printerType || settings.printer_type || 'system';
  try {
    let result;
    if (type === 'network') {
      const targetIp = ip || settings.printer_network_ip;
      const targetPort = parseInt(port || settings.printer_network_port || '9100', 10);
      if (!targetIp) return { success: false, reason: 'IP not provided' };
      const payload = escposPrinter.buildTestPayload();
      result = await escposPrinter.sendBufferToNetwork(payload, targetIp, targetPort);
    } else if (type === 'bluetooth') {
      const targetAddr = comName || settings.bt_printer_address;
      if (!targetAddr) return { success: false, reason: 'Bluetooth printer not configured' };
      const payload = escposPrinter.buildTestPayload();
      const b64 = payload.toString('base64');
      const bluetoothPrinter = require('./services/bluetoothPrinter');
      result = await bluetoothPrinter.sendToBluetooth(targetAddr, b64);
      if (!result.success) result.failureReason = result.failureReason || result.error || result.reason || 'Unknown error';
    } else {
      const testHtml = `<!doctype html><html><head><meta charset="utf-8"><style>
        body { font-family: 'Courier New', monospace; margin: 0; padding: 4mm; text-align: center; }
        h1 { font-size: 18px; } p { font-size: 11px; }
      </style></head><body>
        <h1>Test Print</h1>
        <p>DRP Dynamic Recharge Platform</p>
        <p>&copy; Darpan Adhikari</p>
        <p>https://darpanadhikari.com.np</p>
      </body></html>`;
      result = await printBill({ id: 0 }, testHtml, null);
    }
    if (!result.success) result.failureReason = result.failureReason || result.error || result.reason || 'Unknown error';
    return { ...result, message: 'Test page sent to printer' };
  } catch (err) {
    return { success: false, failureReason: err.message };
  }
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
    const key = `${chargerId}:${connectorId}`;
    if (actionPayload.customer) {
      pendingCustomers.set(key, actionPayload.customer);
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
