# Wiring VoltDesk to your backend

Step-by-step setup so the desktop app talks to the reference server (or your own
backend implementing the contract in [backend-api.md](backend-api.md)).

## 1. Start the backend

```bash
cd reference-server
node server.js
```

Expect to see the listening banner. Credentials default to `admin` / `admin123`
(auth is on unless `AUTH_DISABLED=1`). The server stores everything in
`reference-server/data/data.db`.

Quick sanity from a second terminal:

```bash
node reference-server/conformance-check.js   # expects 13/13 PASS
```

## 2. Open the app's Backend Sync settings

Launch the app → **Settings → Backend Sync**. Fill in:

| Field | Value (reference server default) |
|---|---|
| API Base URL | `http://localhost:8080` (if testing locally; use your LAN IP for another machine) |
| API Key | leave empty — the app will login and use the token |
| Login Endpoint | `/api/login` |
| Username | `admin` |
| Password | `admin123` |
| Bills endpoint | `/api/bills` |
| Transactions endpoint | `/api/transactions` |
| Logs endpoint | `/api/logs` |
| Health endpoint | `/api/health` |
| Company Info endpoint | `/api/company` |
| Bill Format endpoint | `/api/bill/template` |
| Bill Details endpoint | `/api/bill/details` |
| Bill Number endpoint | `/api/bill/next-number` |
| Customer Search endpoint | `/api/customers/search` |

If your backend is plain HTTP (not TLS), tick **Skip SSL certificate
verification** — the app defaults to strict TLS checks.

Save. The app now: logs in at startup, refreshes the token before it expires,
and auto-retries anything that returns `401`.

## 3. Verify the link

- **Health test** — the endpoint card has a **Test** button; you should see
  `API health: 200 (Nms)`.
- **Sync counters** — the same tab shows pending / failed / sent. After a
  charging session ends and a bill is generated, `pending` goes up, then `sent`.

## 4. Make sure a real session flows through

1. Start a charging session on a charger (via the CSMS/OCPP side).
2. Let it stop so the app builds a bill.
3. On the Backend Sync screen confirm `sent` incremented for bills.
4. Verify server side: `node -e` against `data.db` to see the row, or extend
   your backend's API to list it. Check the `server_bill_id` on the app's bill
   after sync (it appears in the bills screen once the POST response returned).

## 5. Company info + invoice prefix

In **Settings → Branding & Invoice**, click **Fetch from API**. The app pulls
name/address/phone/email/logos **and the invoice prefix** from `/api/company`
(`invoice_prefix`/`bill_prefix`/`prefix`) and fills the form. Save to apply.

## 6. Custom bill format (optional)

1. Set **Bill Format endpoint** `/api/bill/template`.
2. In Branding & Invoice, choose the **Custom** display format radio button.
3. Configure **Bill Details endpoint** `/api/bill/details` so the app merges the
   server bill over the local one when rendering (falls back to local data if
   the server is unreachable or returns `404`).

Edit `reference-server/bill-template.html` to change the format; the app's
renderer fills `{{placeholders}}` (full list in backend-api.md).

## 7. Server-assigned invoice numbers (optional)

With **Bill Number endpoint** `/api/bill/next-number` set, the app pre-fetches
the next invoice number from the server and uses it for new bills (refilling the
cache in the background). Offline, it falls back to its local
`bill_prefix + running sequence` — so clients never block on the network.

## Smoke checklist

- [ ] `conformance-check.js` → 13/13 PASS
- [ ] Health test → `200`
- [ ] A generated bill → sync `sent`; `server_bill_id` populated
- [ ] Company fetch pulls name/address/phone/email/prefix with the button
- [ ] Custom format prints with server data when set

## Contract vs. reference

For your real backend, mirror the boxes in [backend-api.md](backend-api.md):

1. `POST /login` → `{ access_token, expires_in }`.
2. `POST /bills`, `/transactions`, `/logs` → fast `2xx`; bills response `{ id }`.
3. `401` on a dead token — the app then re-authenticates and retries automatically.
4. Every GET route responds with the accepted shapes documented.