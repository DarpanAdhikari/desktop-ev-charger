const { BrowserWindow } = require('electron');
const net = require('net');
const fs = require('fs');
const { execSync } = require('child_process');
const db = require('../db/db');

// ESC/POS commands
const ESC = 0x1B;
const GS = 0x1D;
const LF = 0x0A;
const FF = 0x0C;

function escPosInit() {
  return Buffer.from([ESC, 0x40]); // Initialize printer
}

function escPosAlignCenter() {
  return Buffer.from([ESC, 0x61, 0x01]);
}

function escPosAlignLeft() {
  return Buffer.from([ESC, 0x61, 0x00]);
}

function escPosBoldOn() {
  return Buffer.from([ESC, 0x45, 0x01]);
}

function escPosBoldOff() {
  return Buffer.from([ESC, 0x45, 0x00]);
}

function escPosSizeDouble() {
  return Buffer.from([ESC, 0x21, 0x11]);
}

function escPosSizeNormal() {
  return Buffer.from([ESC, 0x21, 0x00]);
}

function escPosText(text) {
  return Buffer.from(text + '\n');
}

function escPosLineFeed(n = 2) {
  return Buffer.alloc(n, LF);
}

function escPosCut() {
  return Buffer.from([GS, 0x56, 0x00]); // Cut paper
}

function padRight(s, len) {
  s = String(s);
  return s.length >= len ? s : s + ' '.repeat(len - s.length);
}

function padLeft(s, len) {
  s = String(s);
  return s.length >= len ? s : ' '.repeat(len - s.length) + s;
}

function divider(ch = '-', len = 42) {
  return ch.repeat(len);
}

function formatDurationEsc(sec) {
  if (!sec || sec <= 0) return '-';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  let parts = [];
  if (h > 0) parts.push(h + 'h');
  if (m > 0) parts.push(m + 'm');
  if (s > 0 || parts.length === 0) parts.push(s + 's');
  return parts.join(' ');
}

function formatDateEsc(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const mon = months[d.getMonth()];
  const day = String(d.getDate()).padStart(2, '0');
  const year = d.getFullYear();
  let h = d.getHours();
  const ampm = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12;
  const min = String(d.getMinutes()).padStart(2, '0');
  return mon + ' ' + day + ', ' + year + ' ' + h + ':' + min + ampm;
}

const LINE_WIDTH = 42;

function buildBillEscPos(bill, tx, settings) {
  const company = settings.company_name || 'Company';
  const w = LINE_WIDTH;

  const buf = [];
  const p = (cmd) => buf.push(cmd);

  p(escPosInit());

  // Header
  p(escPosAlignCenter());
  p(escPosBoldOn());
  p(escPosSizeDouble());
  p(escPosText(company.length > w ? company : company));
  p(escPosSizeNormal());
  p(escPosBoldOff());
  if (settings.company_address) p(escPosText(settings.company_address));
  if (settings.company_phone || settings.company_email) {
    p(escPosText((settings.company_phone || '') + (settings.company_phone && settings.company_email ? ' | ' : '') + (settings.company_email || '')));
  }
  p(escPosText(divider('=')));

  p(escPosAlignLeft());

  // Invoice info
  p(escPosText('Invoice: ' + (bill.bill_number || '-')));
  p(escPosText('Date:    ' + formatDateEsc(bill.created_at)));
  p(escPosText(divider('=')));

  // Session info
  p(escPosBoldOn());
  p(escPosText('Session Information'));
  p(escPosBoldOff());
  p(escPosText('Charger:  ' + (tx.charger_id || '-') + '  Connector: ' + (tx.connector_id || '-')));
  p(escPosText('Duration: ' + formatDurationEsc(tx.duration_sec)));
  p(escPosText('Start:    ' + formatDateEsc(tx.started_at)));
  p(escPosText('End:      ' + formatDateEsc(tx.stopped_at)));

  // Customer
  if (bill.customer_name) {
    p(escPosText('Customer: ' + bill.customer_name + (bill.customer_id ? ' (' + bill.customer_id + ')' : '')));
    if (bill.customer_vehicle) p(escPosText('Vehicle:  ' + bill.customer_vehicle));
  }

  p(escPosText(divider('=')));

  // Energy & Rate
  p(escPosBoldOn());
  p(escPosText('Energy & Rate'));
  p(escPosBoldOff());
  p(escPosText(padRight('Energy', 20) + padLeft((bill.energy_kwh || 0).toFixed(3) + ' kWh', 22)));
  p(escPosText(padRight('Rate per kWh', 20) + padLeft((bill.rate_per_kwh || 0).toFixed(2), 22)));
  if (bill.rate_name) p(escPosText(padRight('Rate Plan', 20) + padLeft(bill.rate_name, 22)));

  p(escPosText(divider('=')));

  // Cost Breakdown
  p(escPosBoldOn());
  p(escPosText('Cost Breakdown'));
  p(escPosBoldOff());
  p(escPosText(padRight('Energy Charge', 20) + padLeft((bill.subtotal || 0).toFixed(2), 22)));

  const hasServiceFee = bill.service_fee && parseFloat(bill.service_fee) > 0;
  const hasServiceCharge = bill.service_charge && parseFloat(bill.service_charge) > 0;
  const hasTax = bill.tax_amount && parseFloat(bill.tax_amount) > 0;

  if (hasServiceFee) p(escPosText(padRight('Service Fee', 20) + padLeft((bill.service_fee || 0).toFixed(2), 22)));
  if (hasServiceCharge) p(escPosText(padRight('Service Charge', 20) + padLeft((bill.service_charge || 0).toFixed(2), 22)));
  if (hasTax) p(escPosText(padRight('Tax (' + (bill.tax_percent || 0) + '%)', 20) + padLeft((bill.tax_amount || 0).toFixed(2), 22)));

  p(escPosText(divider('-')));
  p(escPosBoldOn());
  p(escPosText(padRight('TOTAL', 20) + padLeft((bill.total || 0).toFixed(2), 22)));
  p(escPosBoldOff());

  // SoC
  if (bill.soc_start != null || bill.soc_end != null) {
    p(escPosText(divider('-')));
    const socStart = bill.soc_start != null ? bill.soc_start + '%' : '-';
    const socEnd = bill.soc_end != null ? bill.soc_end + '%' : '-';
    const socDelta = bill.soc_start != null && bill.soc_end != null ? ' (+' + (bill.soc_end - bill.soc_start) + '%)' : '';
    p(escPosText('SoC: ' + socStart + ' -> ' + socEnd + socDelta));
  }

  p(escPosText(divider('=')));

  // Footer
  p(escPosAlignCenter());
  p(escPosText(''));
  p(escPosBoldOn());
  p(escPosText('Thank you for charging!'));
  p(escPosBoldOff());
  p(escPosText(company));
  if (settings.company_phone) p(escPosText(settings.company_phone));
  if (settings.company_email) p(escPosText(settings.company_email));
  p(escPosText(''));
  p(escPosText('\u00A9 Darpan Adhikari'));
  p(escPosText('https://darpanadhikari.com.np'));

  p(escPosLineFeed(3));
  p(escPosCut());

  return Buffer.concat(buf);
}

async function printTextToNetwork(bill, tx, settings, ip, port) {
  const payload = buildBillEscPos(bill, tx, settings);
  return sendBufferToNetwork(payload, ip, port);
}

async function printTextToBluetooth(bill, tx, settings, macAddress) {
  const payload = buildBillEscPos(bill, tx, settings);
  const dataBase64 = payload.toString('base64');
  const bluetoothPrinter = require('./bluetoothPrinter');
  const result = await bluetoothPrinter.sendToBluetooth(macAddress, dataBase64);
  if (!result.success) result.failureReason = result.failureReason || result.error || 'Unknown error';
  return result;
}

function rasterToEscPos(imageBuffer, imgWidth, imgHeight, threshold = 160) {
  const bytesPerRow = Math.ceil(imgWidth / 8);
  const yPixels = imgHeight;

  const header = Buffer.from([GS, 0x76, 0x30, 0x00]);
  const xL = bytesPerRow % 256;
  const xH = Math.floor(bytesPerRow / 256);
  const yL = yPixels % 256;
  const yH = Math.floor(yPixels / 256);

  const rasterData = Buffer.alloc(bytesPerRow * yPixels);
  for (let y = 0; y < yPixels; y++) {
    for (let x = 0; x < imgWidth; x++) {
      const srcIdx = (y * imgWidth + x) * 4; // BGRA
      const b = imageBuffer[srcIdx];
      const g = imageBuffer[srcIdx + 1];
      const r = imageBuffer[srcIdx + 2];
      const brightness = (r * 299 + g * 587 + b * 114) / 1000;
      if (brightness < threshold) {
        const byteIdx = y * bytesPerRow + Math.floor(x / 8);
        const bitIdx = 7 - (x % 8);
        rasterData[byteIdx] |= (1 << bitIdx);
      }
    }
  }

  return Buffer.concat([header, Buffer.from([xL, xH, yL, yH]), rasterData]);
}

async function renderHtmlToBitmap(html, targetDots) {
  const dotWidth = targetDots || 576;
  const cssWidth = Math.max(Math.round(dotWidth * 96 / 203), 1);
  const zoom = dotWidth / cssWidth;

  const win = new BrowserWindow({
    show: false,
    width: Math.round(cssWidth * zoom) + 20,
    height: 800,
    webPreferences: { contextIsolation: true, enableWebSQL: false }
  });
  try {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    await win.webContents.executeJavaScript('document.fonts.ready');

    await win.webContents.executeJavaScript(
      `document.body.style.cssText = 'width:${cssWidth}px;margin:0;padding:0;';`
    );
    await win.webContents.executeJavaScript('new Promise(r => requestAnimationFrame(r))');

    win.webContents.zoomFactor = zoom;
    await win.webContents.executeJavaScript('new Promise(r => requestAnimationFrame(r))');

    const dims = await win.webContents.executeJavaScript(
      `({w:document.body.scrollWidth,h:Math.max(document.body.scrollHeight,document.documentElement.scrollHeight)})`
    );
    win.setContentBounds({
      x: 0, y: 0,
      width: Math.ceil(dims.w * win.webContents.zoomFactor),
      height: Math.min(Math.ceil(dims.h * win.webContents.zoomFactor), 3000)
    });
    await win.webContents.executeJavaScript('new Promise(r => requestAnimationFrame(r))');

    const image = await win.webContents.capturePage();
    const resized = image.resize({ width: dotWidth });
    const bitmap = resized.getBitmap();
    return { pngBuffer: resized.toPNG(), bitmap, width: dotWidth, height: resized.getSize().height };
  } finally {
    win.close();
  }
}

function targetDotsFromPaperWidth(paperWidth) {
  const printableMm = Math.max(parseInt(paperWidth || '80', 10) - 4, 30);
  return Math.round(printableMm * 8);
}

async function printImageToNetwork(html, ip, port = 9100, targetDots) {
  const { bitmap, width, height } = await renderHtmlToBitmap(html, targetDots);
  const rasterData = rasterToEscPos(bitmap, width, height);
  const payload = Buffer.concat([
    escPosInit(),
    rasterData,
    escPosLineFeed(3),
    escPosCut(),
  ]);
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    socket.setTimeout(10000);
    socket.connect(port, ip, () => {
      socket.write(payload, (err) => {
        if (err) { socket.destroy(); reject(err); return; }
        socket.end();
        resolve({ success: true });
      });
    });
    socket.on('error', (err) => { reject(err); });
    socket.on('timeout', () => { socket.destroy(); reject(new Error('Connection timeout')); });
  });
}

async function printImageToBluetooth(html, macAddress, targetDots) {
  const { bitmap, width, height } = await renderHtmlToBitmap(html, targetDots);
  const rasterData = rasterToEscPos(bitmap, width, height);
  const payload = Buffer.concat([
    escPosInit(),
    rasterData,
    escPosLineFeed(3),
    escPosCut(),
  ]);
  const dataBase64 = payload.toString('base64');
  const bluetoothPrinter = require('./bluetoothPrinter');
  const result = await bluetoothPrinter.sendToBluetooth(macAddress, dataBase64);
  if (!result.success) result.failureReason = result.failureReason || result.error || 'Unknown error';
  return result;
}

function listComPorts() {
  try {
    const result = execSync(
      'powershell -NoProfile -Command "[System.IO.Ports.SerialPort]::GetPortNames()"',
      { encoding: 'utf8', timeout: 5000 }
    );
    return result.trim().split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}

function buildTestPayload() {
  const line = '='.repeat(42);
  return Buffer.concat([
    escPosInit(),
    escPosAlignCenter(),
    escPosSizeDouble(),
    escPosText('Test Print'),
    escPosSizeNormal(),
    escPosText(line),
    escPosText(''),
    escPosText('DRP Dynamic Recharge Platform'),
    escPosText(''),
    escPosText(line),
    escPosText(''),
    escPosText('\u00A9 Darpan Adhikari'),
    escPosText('https://darpanadhikari.com.np'),
    escPosText(''),
    escPosText(line),
    escPosLineFeed(3),
    escPosCut(),
  ]);
}

function sendBufferToNetwork(buffer, ip, port) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    socket.setTimeout(10000);
    socket.connect(port, ip, () => {
      socket.write(buffer, (err) => {
        if (err) { socket.destroy(); reject(err); return; }
        socket.end();
        resolve({ success: true });
      });
    });
    socket.on('error', (err) => { reject(err); });
    socket.on('timeout', () => { socket.destroy(); reject(new Error('Connection timeout')); });
  });
}

module.exports = {
  printImageToNetwork,
  printImageToBluetooth,
  printTextToNetwork,
  printTextToBluetooth,
  buildBillEscPos,
  renderHtmlToBitmap,
  rasterToEscPos,
  listComPorts,
  escPosInit,
  escPosAlignCenter,
  escPosSizeDouble,
  escPosSizeNormal,
  escPosText,
  escPosCut,
  escPosLineFeed,
  targetDotsFromPaperWidth,
  buildTestPayload,
  sendBufferToNetwork,
};