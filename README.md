# DRP Dynamic Recharge Platform

Electron console for an OCPP 1.6 CSMS: live charger/connector monitoring, per-session
billing with shift-based tariffs and tax, direct invoice printing (network, Bluetooth,
and system printer), and offline-first sync of bills/logs/transactions to a backend server.

## Scripts

```bash
npm install            # install dependencies + rebuild better-sqlite3
npm run dev            # dev mode (Vite hot-reload + Electron)
npm run build:renderer # production build of the renderer (Vite)
npm start              # launch Electron with current build
npm run dist           # package distributable (electron-builder)
```

## Run it

```bash
npm install
npm run build:renderer
npm start
```

On first launch, go to **Settings** and set your CSMS WebSocket URL
(e.g. `wss://your-server:6008`) — nothing connects until you do.

## Printing

Three printer modes supported in Settings:

| Mode | How it works |
|---|---|
| **System** | Uses `webContents.print()` — sends HTML to a Windows system printer (default or user-picked). |
| **Network** | Connects to an ESC/POS thermal printer via TCP/IP (port 9100). Renders the bill HTML to a high-resolution bitmap, converts to `GS v 0` raster format, and sends raw ESC/POS. |
| **Bluetooth** | Connects to a paired Bluetooth SPP printer. Falls through three methods: persistent WinRT daemon → one-shot RFCOMM script → direct COM port write (auto-baud). |

Paper width (80mm / 58mm / custom) is configurable per printer type. Test print
uses raw ESC/POS text commands (init, alignment, line feeds, cut) for crisp
printer-native font rendering at 203 DPI.

## Backend sync

The app talks to your backend over the REST contract documented in
[`docs/backend-api.md`](docs/backend-api.md): it ingests bills/logs/transactions
from a local outbox, and reads company info, customer search, the optional
"Custom" bill format, bill details, and server-assigned invoice numbers.

A dependency-free **reference backend** implements that contract and can run
as-is to connect the app end-to-end — see
[`reference-server/`](reference-server/README.md) (`node server.js`) and the
step-by-step wiring in [`docs/BACKEND_SETUP.md`](docs/BACKEND_SETUP.md).
`reference-server/conformance-check.js` verifies any server against all 13
contract assertions.

## What still needs you

1. **Predicted finish time.** The CSMS already streams SoC in `meter` events.
   The renderer has a placeholder (`estimateEta`) — next step is to track a
   rolling SoC-per-minute rate per active transaction in the main process (or
   push it down from the server side) and stream it through so the charger
   cards can show a real ETA.
2. **Shift-spanning sessions.** Currently a bill is priced entirely at the shift
   active when the session *started*. If you want a session that crosses a
   shift boundary to be split and priced proportionally, say so and I'll adjust
   `billing.js`.

## Architecture

```
main/
  main.js              window + IPC wiring + service lifecycle
  preload.js           contextBridge surface (the only thing renderer can call)
  bt-rfcomm.ps1        one-shot PowerShell RFCOMM connect / send / scan / pair
  bt-rfcomm-daemon.ps1 persistent PowerShell daemon (WinRT Bluetooth socket)
  db/
    schema.sql          SQLite schema
    db.js               settings get/set, bill numbering
  services/
    wsClient.js          persistent CSMS connection, event → SQLite mirroring
    billing.js           shift lookup + bill generation
    billTemplate.js      HTML invoice (professional / enhanced / original / custom)
    printService.js       system printer (webContents.print) + success/fail counters
    escposPrinter.js     ESC/POS rendering: HTML→bitmap capture, raster encoding,
                         raw test payload generation, network socket + Bluetooth send
    bluetoothPrinter.js  Bluetooth discovery, daemon manager, COM port fallback,
                         baud rate detection, startup reconnect
    syncWorker.js        outbox drain to backend API
    apiAuth.js           login/token flow, 401 re-auth
    billNumber.js        server-assigned bill number pre-fetch
reference-server/        runnable reference backend + conformance check
docs/                    backend-api.md (contract) + BACKEND_SETUP.md (wiring)
renderer/
  src/                   React app (Vite + React Router)
    pages/               Settings, Chargers, Bills, Logs views
    components/          UI components (gauge, table, modal, etc.)
  dist/                  production build output
```

Design language: near-black control-room palette, amber for "live/charging",
teal for "available", red for faults — monospace throughout.
