# VoltDesk

Electron console for an OCPP 1.6 CSMS: live charger/connector monitoring, per-session
billing with shift-based tariffs and tax, direct invoice printing, and offline-first
sync of bills/logs/transactions to a backend server.

**DRP (Dynamic Rendering & Print Browser)** is meant to align with this app,
not just sit beside it: DRP's print engine (silent-print pipeline,
multi-printer-type support, rule builder) is the intended printing backend for
VoltDesk's invoices, rather than VoltDesk owning its own separate print path.
`printService.js` currently calls `webContents.print()` directly as a
stand-in — swapping it to hand off to DRP's pipeline instead is the next real
step here (I don't have DRP's source in this workspace yet, so I've left the
integration point isolated in `printService.js` so it's a contained swap once
that's available).

## Status: working scaffold (Phase 0)

This is a real, runnable skeleton wired end-to-end — not a mockup. What's implemented:

- Main-process WebSocket client that connects to the CSMS URL you set in Settings,
  reconnects automatically, and mirrors `boot` / `heartbeat` / `status_transition` /
  `transaction_started` / `meter` / `transaction_stopped` events into SQLite.
- SQLite schema (`better-sqlite3`) for chargers, connectors, transactions, bills,
  shifts, settings, logs, and a generic `sync_queue` outbox.
- Billing engine: on `transaction_stopped`, picks the active shift by start time
  (handles overnight-wrapping shifts), applies that shift's rate/kWh and tax %,
  generates a numbered bill (`PREFIX-00001`), and queues it for sync.
- Silent invoice printing via `webContents.print()`, with running success/fail
  counters per bill and a reprint action.
- Background sync worker draining the outbox to your backend on a timer, per
  configured endpoint, with retry/attempt tracking.
- Renderer UI: charger listing with connector status chips, a charger detail view
  with an animated ring gauge per connector (amber pulse while charging), a billing
  list + invoice modal, a raw log viewer, and a settings screen for the websocket
  URL, branding, bill format, shifts/tax, and backend sync endpoints.

## Run it

```bash
npm install
npm start
```

On first launch, go to **Settings** and set your CSMS WebSocket URL
(e.g. `wss://your-server:6008`) — nothing connects until you do.

## What still needs you

1. **Backend API contract.** `syncWorker.js` POSTs each queued bill/log/transaction
   as JSON to `api_base_url + <entity endpoint path>`. Once you share the actual
   docs for those endpoints (auth scheme, payload shape, response codes), I'll
   adjust the worker to match exactly — right now it assumes a simple
   `Authorization: Bearer <api_key>` + `200 OK` contract.
2. **Predicted finish time.** The CSMS already streams SoC in `meter` events.
   The renderer has a placeholder (`estimateEta`) — next step is to track a
   rolling SoC-per-minute rate per active transaction in the main process (or
   push it down from the Python side) and stream it through so the charger
   cards can show a real ETA.
3. **Printer picker.** `printService.js` accepts a `deviceName`; Settings needs
   a dropdown populated from `webContents.getPrintersAsync()` so users can pick
   a specific thermal/receipt printer instead of the OS default.
4. **Shift-spanning sessions.** Currently a bill is priced entirely at the shift
   active when the session *started*. If you want a session that crosses a
   shift boundary to be split and priced proportionally, say so and I'll adjust
   `billing.js`.
5. **Packaging.** `electron-builder` config is in `package.json`; icons and
   platform-specific signing aren't set up yet.

## Architecture

```
main/
  main.js            window + IPC wiring + service lifecycle
  preload.js          contextBridge surface (the only thing renderer can call)
  db/
    schema.sql         SQLite schema
    db.js               settings get/set, bill numbering
  services/
    wsClient.js         persistent CSMS connection, event → SQLite mirroring
    billing.js          shift lookup + bill generation
    billTemplate.js      HTML invoice for thermal_80mm / A4
    printService.js      silent print + success/fail counters
    syncWorker.js         outbox drain to backend API
renderer/
  index.html / styles.css / app.js   single-page UI, no build step
```

Design language: near-black control-room palette, amber for "live/charging",
teal for "available", red for faults — Space Grotesk for headings, JetBrains
Mono for live meter/billing data.
