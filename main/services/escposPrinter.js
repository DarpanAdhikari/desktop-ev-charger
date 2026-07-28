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
  const win = new BrowserWindow({
    show: false, width: 800, height: 800,
    webPreferences: { contextIsolation: true, enableWebSQL: false }
  });
  try {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    await win.webContents.executeJavaScript('document.fonts.ready');

    const dotWidth = targetDots || 576;
    const renderScale = 2;

    await win.webContents.executeJavaScript(`document.body.style.width = '${dotWidth}px';`);
    await new Promise((r) => setTimeout(r, 150));

    win.webContents.zoomFactor = renderScale;
    await new Promise((r) => setTimeout(r, 200));

    const dims = await win.webContents.executeJavaScript(
      `({ width: document.body.scrollWidth, height: Math.max(document.body.scrollHeight, document.documentElement.scrollHeight) })`
    );
    const contentW = Math.ceil(dims.width * renderScale) + 2;
    const contentH = Math.min(Math.ceil(dims.height * renderScale), 3000);
    win.setContentBounds({ x: 0, y: 0, width: contentW, height: contentH });
    await new Promise((r) => setTimeout(r, 200));
    const image = await win.webContents.capturePage();

    const finalWidth = dotWidth;
    const finalHeight = Math.max(Math.round(image.getSize().height * finalWidth / image.getSize().width), 1);
    const resized = image.resize({ width: finalWidth, height: finalHeight });
    const bitmap = resized.getBitmap();
    return { pngBuffer: resized.toPNG(), bitmap, width: finalWidth, height: finalHeight };
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
        socket.destroy();
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
        socket.destroy();
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