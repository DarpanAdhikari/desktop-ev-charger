const { ipcMain } = require('electron');
const { exec, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const DAEMON_TIMEOUT = 30000;
const DAEMON_SPAWN_TIMEOUT = 15000;
const SCRIPT_TIMEOUT = 60000;
const SERIAL_BAUD_TIMEOUT = 5000;
const BT_BAUD_RATES = [9600, 19200, 38400, 115200, 57600, 230400];

function execAsync(command, timeout) {
  return new Promise((resolve, reject) => {
    exec(command, { timeout, encoding: 'utf-8' }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || stdout || err.message).trim()));
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

function resolveScript(script) {
  const candidates = [
    path.join(__dirname, '..', script),
    path.join(__dirname, '..', '..', '..', 'main', script), // dev mode
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return candidates[0];
}

function scriptPath() { return resolveScript('bt-rfcomm.ps1'); }
function daemonScriptPath() { return resolveScript('bt-rfcomm-daemon.ps1'); }

async function execRfcommScript(command, address, data, deviceName) {
  const sp = scriptPath();
  let tmpFile = null;
  const errors = [];
  try {
    if (command === 'send' && data) {
      tmpFile = path.join(os.tmpdir(), `bt_send_${Date.now()}_${Math.random().toString(36).slice(2)}.tmp`);
      fs.writeFileSync(tmpFile, data, 'utf8');
    }
    for (const shell of ['pwsh', 'powershell']) {
      try {
        let cmd = `${shell} -NoProfile -ExecutionPolicy Bypass -File "${sp}" -Command ${command}`;
        if (address) cmd += ` -Address "${address}"`;
        if (tmpFile) cmd += ` -DataFilePath "${tmpFile}"`;
        else if (data) cmd += ` -Data "${data}"`;
        if (deviceName) cmd += ` -DeviceName "${deviceName}"`;
        const { stdout } = await execAsync(cmd, SCRIPT_TIMEOUT);
        return JSON.parse(stdout.trim());
      } catch (err) {
        errors.push(`${shell}: ${err.message}`);
      }
    }
    return { success: false, error: errors.join('; ') };
  } finally {
    if (tmpFile) { try { fs.unlinkSync(tmpFile); } catch {} }
  }
}

// ─── Persistent Bluetooth Daemon Manager ────────────────────────────────────────

class BluetoothDaemonManager {
  constructor() {
    this.sessions = new Map();
  }

  async connect(macAddress) {
    await this.disconnect(macAddress);

    const sp = daemonScriptPath();
    if (!fs.existsSync(sp)) return { success: false, error: 'Daemon script not found' };

    const proc = spawn('powershell', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-File', sp,
      '-Address', macAddress
    ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

    const session = { proc, pending: new Map(), nextId: 1, buffer: '', connected: false };
    this.sessions.set(macAddress, session);

    proc.stdout.on('data', (chunk) => {
      session.buffer += chunk.toString();
      const lines = session.buffer.split('\n');
      session.buffer = lines.pop() || '';
      for (const line of lines) {
        try {
          const resp = JSON.parse(line.trim());
          this._handleResponse(macAddress, resp);
        } catch {}
      }
    });

    proc.on('exit', () => {
      for (const [, p] of session.pending) { clearTimeout(p.timer); p.reject(new Error('Daemon exited')); }
      session.pending.clear();
      session.connected = false;
      this.sessions.delete(macAddress);
    });

    proc.on('error', (err) => {
      for (const [, p] of session.pending) { clearTimeout(p.timer); p.reject(err); }
      session.pending.clear();
      session.connected = false;
      this.sessions.delete(macAddress);
    });

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        session.pending.delete(0);
        resolve({ success: false, error: 'Daemon connection timeout' });
      }, DAEMON_SPAWN_TIMEOUT);

      session.pending.set(0, {
        resolve: (resp) => {
          clearTimeout(timer);
          if (resp.success) { session.connected = true; resolve({ success: true }); }
          else { this.sessions.delete(macAddress); resolve({ success: false, error: resp.error || resp.message || 'Connection failed' }); }
        },
        reject: (err) => {
          clearTimeout(timer);
          this.sessions.delete(macAddress);
          resolve({ success: false, error: String(err) });
        },
        timer
      });
    });
  }

  _handleResponse(macAddress, response) {
    const session = this.sessions.get(macAddress);
    if (!session) return;
    const pending = session.pending.get(response.id);
    if (pending) {
      clearTimeout(pending.timer);
      session.pending.delete(response.id);
      pending.resolve(response);
    }
  }

  async send(macAddress, dataBase64) {
    const session = this.sessions.get(macAddress);
    if (!session || !session.connected) return { success: false, error: 'Bluetooth not connected' };
    return this._sendCommand(macAddress, { command: 'send', data: dataBase64 });
  }

  async ping(macAddress) {
    const session = this.sessions.get(macAddress);
    if (!session || !session.connected) return false;
    try {
      const r = await this._sendCommand(macAddress, { command: 'ping' });
      return r.success === true;
    } catch { return false; }
  }

  async disconnect(macAddress) {
    const session = this.sessions.get(macAddress);
    if (!session) return;
    try {
      if (session.connected) await this._sendCommand(macAddress, { command: 'disconnect' });
    } catch {} finally {
      if (session.proc && !session.proc.killed) {
        try { session.proc.stdin.end(); } catch {}
        setTimeout(() => { try { session.proc.kill(); } catch {} }, 2000);
      }
      this.sessions.delete(macAddress);
    }
  }

  async disconnectAll() {
    for (const addr of this.sessions.keys()) await this.disconnect(addr);
  }

  isConnected(macAddress) {
    return this.sessions.get(macAddress)?.connected === true;
  }

  _sendCommand(macAddress, command) {
    return new Promise((resolve, reject) => {
      const session = this.sessions.get(macAddress);
      if (!session || !session.proc.stdin?.writable) return reject(new Error('Session not available'));
      const id = session.nextId++;
      command.id = id;
      const timer = setTimeout(() => { session.pending.delete(id); reject(new Error('Command timeout')); }, DAEMON_TIMEOUT);
      session.pending.set(id, { resolve, reject, timer });
      try { session.proc.stdin.write(JSON.stringify(command) + '\n'); }
      catch (err) { clearTimeout(timer); session.pending.delete(id); reject(err); }
    });
  }
}

const btDaemonManager = new BluetoothDaemonManager();

// ─── Device Discovery ────────────────────────────────────────────────────────────

const discoveredDevices = [];

function inferDeviceType(name) {
  const lower = (name || '').toLowerCase();
  const printerKw = ['printer', 'print', 'xp-', 'pos', 'thermal', 'label', 'receipt', 'esc', 'epson', 'star ', 'bixolon', 'zebra', 'brother', 'gprinter', 'rongta', 'munbyn', 'goojprt', 'peripage', 'phomemo', 'niimbot', 'hprt', 'sewoo'];
  if (printerKw.some(k => lower.includes(k))) return 'printer';
  return 'unknown';
}

async function scanBluetooth() {
  discoveredDevices.length = 0;
  let btDevices = [];
  try {
    const { stdout } = await execAsync(
      `powershell -NoProfile -Command "Get-PnpDevice -Class Bluetooth -ErrorAction SilentlyContinue | Where-Object { $_.FriendlyName -and $_.InstanceId -notlike 'BTH*LOCALMFG*' -and $_.FriendlyName -notlike '*Bluetooth*adapter*' -and $_.FriendlyName -notlike '*Radio*' } | Select-Object FriendlyName, InstanceId, Status | ConvertTo-Json -Compress"`,
      15000
    );
    if (stdout.trim()) {
      const parsed = JSON.parse(stdout.trim());
      btDevices = Array.isArray(parsed) ? parsed : [parsed];
    }
  } catch {}

  const comPortMap = new Map();
  try {
    const { stdout } = await execAsync(
      `powershell -NoProfile -Command "Get-PnpDevice -Class Ports -ErrorAction SilentlyContinue | Where-Object { $_.FriendlyName -like '*Bluetooth*' -or $_.InstanceId -like '*BTHENUM*' } | Select-Object FriendlyName, InstanceId | ConvertTo-Json -Compress"`,
      10000
    );
    if (stdout.trim()) {
      const ports = JSON.parse(stdout.trim());
      const portList = Array.isArray(ports) ? ports : [ports];
      for (const p of portList) {
        const comMatch = p.FriendlyName?.match(/\((COM\d+)\)/);
        const macMatch = p.InstanceId?.match(/([0-9A-Fa-f]{12})(?!.*[0-9A-Fa-f]{12})/i);
        if (comMatch && macMatch) {
          const mac = macMatch[1].toUpperCase().replace(/(.{2})(?!$)/g, '$1:');
          comPortMap.set(mac, comMatch[1]);
        }
      }
    }
  } catch {}

  let rfcommDevices = [];
  try {
    const rf = await execRfcommScript('scan');
    if (rf.success && rf.devices) rfcommDevices = rf.devices;
  } catch {}

  const now = new Date().toISOString();
  for (const dev of btDevices) {
    const macMatch = dev.InstanceId?.match(/([0-9A-Fa-f]{12})/i);
    const rawMac = macMatch ? macMatch[1].toUpperCase() : '';
    const macAddress = rawMac.replace(/(.{2})(?!$)/g, '$1:');
    const comPort = comPortMap.get(macAddress);
    const hasRfcomm = rfcommDevices.some(r => r.macAddress === macAddress);
    const isConnected = !!comPort || hasRfcomm;
    const existing = discoveredDevices.find(d => d.macAddress === macAddress && macAddress !== '');
    if (existing) {
      existing.name = dev.FriendlyName;
      existing.status = isConnected ? 'connected' : 'available';
      existing.connected = isConnected;
      existing.comPort = comPort || existing.comPort;
      existing.lastSeen = now;
    } else {
      discoveredDevices.push({
        address: macAddress,
        name: dev.FriendlyName,
        macAddress,
        comPort,
        connected: isConnected,
        paired: true,
        deviceType: inferDeviceType(dev.FriendlyName),
        status: isConnected ? 'connected' : 'available',
        lastSeen: now
      });
    }
  }
  for (const rf of rfcommDevices) {
    if (rf.macAddress && !discoveredDevices.find(d => d.macAddress === rf.macAddress)) {
      discoveredDevices.push({
        address: rf.macAddress,
        name: rf.name || 'Unknown',
        macAddress: rf.macAddress,
        comPort: undefined,
        connected: false,
        paired: true,
        deviceType: inferDeviceType(rf.name || ''),
        status: 'available',
        lastSeen: now
      });
    }
  }
  return { success: true, devices: discoveredDevices };
}

// ─── Connect / Disconnect ────────────────────────────────────────────────────────

async function connectBluetooth(address) {
  const device = discoveredDevices.find(d => d.address === address || d.macAddress === address);
  if (!device) return { success: false, error: 'Device not found' };

  const mac = device.macAddress || address;

  // Try persistent daemon
  const daemonResult = await btDaemonManager.connect(mac);
  if (daemonResult.success) {
    device.connected = true;
    device.status = 'connected';
    return { success: true };
  }

  // Fall back to one-shot RFCOMM
  const rfResult = await execRfcommScript('connect', mac);
  if (rfResult.success) {
    device.connected = true;
    device.status = 'connected';
    return { success: true };
  }

  // Try COM port direct write
  if (device.comPort) {
    try {
      const portPath = `\\\\.\\${device.comPort}`;
      const fd = fs.openSync(portPath, 'r+');
      fs.closeSync(fd);
      device.connected = true;
      device.status = 'connected';
      return { success: true };
    } catch {}
  }

  return { success: false, error: daemonResult.error || rfResult.error || 'Could not connect' };
}

async function disconnectBluetooth(address) {
  const device = discoveredDevices.find(d => d.address === address || d.macAddress === address);
  if (!device) return { success: false, error: 'Device not found' };
  const mac = device.macAddress || address;
  await btDaemonManager.disconnect(mac);
  device.connected = false;
  device.status = 'available';
  return { success: true };
}

// ─── Send Data ────────────────────────────────────────────────────────────────────

const baudRateCache = new Map();

async function sendViaComPortPowerShell(comPort, dataBase64) {
  const buffer = Buffer.from(dataBase64, 'base64');
  const cachedBaud = baudRateCache.get(comPort);
  const ratesToTry = cachedBaud
    ? [cachedBaud, ...BT_BAUD_RATES.filter((b) => b !== cachedBaud)]
    : BT_BAUD_RATES;

  for (const baud of ratesToTry) {
    const scriptPath = path.join(os.tmpdir(), 'drp-bt-send.ps1');
    const script = [
      'Add-Type -AssemblyName System -ErrorAction Stop',
      'try {',
      `  $port = New-Object System.IO.Ports.SerialPort "${comPort}", ${baud}, None, 8, One`,
      '  $port.ReadTimeout = 2000',
      '  $port.WriteTimeout = 3000',
      '  $port.Open()',
      `  $bytes = [System.Convert]::FromBase64String("${dataBase64}")`,
      '  $port.Write($bytes, 0, $bytes.Length)',
      '  $port.Close()',
      '  Write-Host OK',
      '} catch {',
      '  Write-Host FAIL',
      '  exit 1',
      '}'
    ].join('\n');
    try {
      fs.writeFileSync(scriptPath, script, 'utf-8');
      const { stdout } = await execAsync(
        `powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`,
        SERIAL_BAUD_TIMEOUT
      );
      if (stdout.trim() === 'OK') {
        baudRateCache.set(comPort, baud);
        try { fs.unlinkSync(scriptPath); } catch {}
        return { success: true };
      }
    } catch {
    } finally {
      try { fs.unlinkSync(scriptPath); } catch {}
    }
  }
  return { success: false, error: `Could not write to ${comPort} at any baud rate` };
}

async function sendToBluetooth(address, dataBase64, comPortOverride) {
  try {
    const mac = (address || '').toUpperCase();
    let device = discoveredDevices.find(d => d.address === mac || d.macAddress === mac);

    let comPort = comPortOverride || device?.comPort;
    if (!comPort) {
      comPort = await findComPortForMac(mac);
      if (comPort) device = upsertDevice(mac, false, comPort);
    }

    if (!btDaemonManager.isConnected(mac)) {
      await btDaemonManager.connect(mac);
    }

    const daemonResult = await btDaemonManager.send(mac, dataBase64);
    if (daemonResult.success) return { success: true };

    const rfResult = await execRfcommScript('send', mac, dataBase64);
    if (rfResult.success) return { success: true };

    if (comPort) {
      const portPath = comPort.startsWith('\\\\.\\') ? comPort : `\\\\.\\${comPort}`;
      try {
        fs.writeFileSync(portPath, Buffer.from(dataBase64, 'base64'));
        return { success: true };
      } catch {}

      const psResult = await sendViaComPortPowerShell(comPort, dataBase64);
      if (psResult.success) return { success: true };

      return { success: false, error: `Failed to write to ${comPort}: tried direct write and PowerShell SerialPort` };
    }

    return { success: false, error: rfResult.error || 'Could not send to Bluetooth device' };
  } catch (err) {
    return { success: false, error: String(err.message || err) };
  }
}

// ─── Startup Reconnect ────────────────────────────────────────────────────────────

async function quickTestBluetooth(macAddress) {
  const daemonAlive = await btDaemonManager.ping(macAddress);
  if (daemonAlive) { upsertDevice(macAddress, true); return 'online'; }

  const comPort = await findComPortForMac(macAddress);
  if (comPort) {
    try {
      fs.writeFileSync(`\\\\.\\${comPort}`, Buffer.from([0x0A]));
      upsertDevice(macAddress, true, comPort);
      return 'online';
    } catch {}
  }

  try {
    const tiny = Buffer.from([0x0A]).toString('base64');
    const rf = await execRfcommScript('send', macAddress, tiny);
    if (rf.success) { upsertDevice(macAddress, true); return 'online'; }
  } catch {}

  upsertDevice(macAddress, false);
  return 'offline';
}

async function reconnectBluetoothPrinter(macAddress) {
  if (!macAddress) return { success: false, error: 'No address' };
  const status = await quickTestBluetooth(macAddress);
  if (status === 'online') return { success: true };

  const daemonResult = await btDaemonManager.connect(macAddress);
  if (daemonResult.success) { upsertDevice(macAddress, true); return { success: true }; }
  return { success: false, error: daemonResult.error || 'Reconnection failed' };
}

function upsertDevice(macAddress, connected, comPort) {
  const existing = discoveredDevices.find(d => d.macAddress === macAddress);
  if (existing) {
    existing.connected = connected;
    existing.status = connected ? 'connected' : 'available';
    existing.lastSeen = new Date().toISOString();
    if (comPort) existing.comPort = comPort;
    return existing;
  }
  const device = { address: macAddress, name: 'Bluetooth Printer', macAddress, comPort, connected, paired: true, deviceType: 'printer', status: connected ? 'connected' : 'available', lastSeen: new Date().toISOString() };
  discoveredDevices.push(device);
  return device;
}

async function findComPortForMac(macAddress) {
  try {
    const { stdout } = await execAsync(
      `powershell -NoProfile -Command "Get-PnpDevice -Class Ports -ErrorAction SilentlyContinue | Where-Object { $_.InstanceId -like '*BTHENUM*' } | Select-Object FriendlyName, InstanceId | ConvertTo-Json -Compress"`,
      10000
    );
    if (!stdout.trim()) return null;
    const parsed = JSON.parse(stdout.trim());
    const ports = Array.isArray(parsed) ? parsed : [parsed];
    for (const p of ports) {
      const comMatch = p.FriendlyName?.match(/\((COM\d+)\)/);
      const macMatch = p.InstanceId?.match(/([0-9A-Fa-f]{12})(?!.*[0-9A-Fa-f]{12})/i);
      if (comMatch && macMatch) {
        const found = macMatch[1].toUpperCase().replace(/(.{2})(?!$)/g, '$1:');
        if (found === macAddress) return comMatch[1];
      }
    }
  } catch {}
  return null;
}

// ─── IPC Handlers ─────────────────────────────────────────────────────────────────

function registerBluetoothHandlers() {
  ipcMain.handle('bluetooth:scan', async () => {
    const result = await scanBluetooth();
    return result.devices || [];
  });
  ipcMain.handle('bluetooth:connect', async (_e, address) => connectBluetooth(address));
  ipcMain.handle('bluetooth:disconnect', async (_e, address) => disconnectBluetooth(address));
  ipcMain.handle('bluetooth:list', () => discoveredDevices);
  ipcMain.handle('bluetooth:send', async (_e, address, dataBase64) => sendToBluetooth(address, dataBase64));
  ipcMain.handle('bluetooth:test', async (_e, address) => {
    const testData = [
      0x1B, 0x40, // init
      0x1B, 0x61, 0x01, // center
      ...Buffer.from('=== DRP EV App Test ===\n').toJSON().data,
      0x1B, 0x21, 0x11, // double size
      ...Buffer.from('TEST PRINT\n').toJSON().data,
      0x1B, 0x21, 0x00, // normal
      ...Buffer.from('\nBluetooth OK\n').toJSON().data,
      ...Buffer.from('\n').toJSON().data,
      0x1D, 0x56, 0x00, // cut
    ];
    const b64 = Buffer.from(testData).toString('base64');
    return sendToBluetooth(address, b64);
  });
}

function cleanupBluetoothDaemons() {
  btDaemonManager.disconnectAll();
}

module.exports = {
  registerBluetoothHandlers,
  cleanupBluetoothDaemons,
  reconnectBluetoothPrinter,
  scanBluetooth,
  connectBluetooth,
  disconnectBluetooth,
  sendToBluetooth,
  quickTestBluetooth,
  getDiscoveredDevices: () => discoveredDevices,
  btDaemonManager,
};