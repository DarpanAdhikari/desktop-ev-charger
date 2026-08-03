# VoltDesk / DRP Backend API contract

This is the exact HTTP contract the **VoltDesk desktop app** uses to talk to your
backend. Your backend only ever needs to expose the endpoints below (all other
data the app needs arrives through the CSMS WebSocket, not this API).

A runnable reference implementation lives in `reference-server/`. It is the
source of truth for this contract; keep the two in sync when you extend either.

- Reference server: [`reference-server/server.js`](../reference-server/server.js)
- App-side setup guide: [`BACKEND_SETUP.md`](BACKEND_SETUP.md)

## Quick overview

```
 VoltDesk app                                   Your backend
 ──────────────                                 ──────────────
  Settings:  api_base_url + <path per setting>  →  HTTP
  [optional] POST /login            → access_token + expires_in
  every call   Authorization: Bearer <token>  (or <api_key>)
              POST /bills   (full bill row)   → 2xx + { id }
              POST /transactions (full session row)
              POST /logs    (raw CSMS event)
              GET /health, /company, /customers/search
              GET /bill/template, /bill/details, /bill/next-number
```

All endpoints live under the configured `api_base_url` (e.g. `https://billing.example.com`).
Each endpoint path is entered separately in the app's **Settings → Backend Sync** tab —
there is no hardcoded router enclosure. The defaults in this repo are `/api/...`.

## General rules

| Rule | Value |
|---|---|
| Base URL | `api_base_url`; paths are appended verbatim (`base + path`) |
| Auth | `Authorization: Bearer <token-or-api-key>` on every call (see Auth) |
| Content-Type | `application/json` (POST bodies) |
| Success | any `2xx` for a POST is "accepted"; the response body is optional except where noted |
| Errors | `5xx` and `4xx` are retried up to 8 attempts/row by the app's outbox |
| Timeouts | health check: 5s; others: OS socket timeout (10s) |
| Cadence | outbox drain every 10s, 20 rows max/attempt, max 8 attempts/row |

> `401` is special: the app **clears the token, re-logins once, and retries the
> same request once**. So an expired token never loses a bill.

## Auth

### Login (POST `api_login_endpoint`)

Only used when a login endpoint **and** username/password are configured.

```
POST /api/login
Content-Type: application/json

{ "username": "operator", "password": "sekret" }
```

Accepted success responses — the `access_token`/`token`/`jwt` field may sit at the
root or inside a `data` wrapper:

```json
{ "access_token": "eyJ...", "token_type": "Bearer", "expires_in": 86400 }
```

| Field | Meaning |
|---|---|
| `access_token` / `token` / `jwt` | the bearer token to use on all subsequent calls (any one of these 3 names) |
| `expires_in` (seconds) | *recommended* — app refreshes ~30s before expiry |
| `token_lifetime` (seconds) | alternative name |
| `expires_at` (ISO) | absolute expiry, alternative to the two above |

- Omit expiry → the app trusts the token until it sees a `401`.
- `401` on login = invalid credentials — the app waits and retries later.
- If no login endpoint is configured, the app falls back to the static `api_key`
  setting as the bearer token and never calls `/login`.

### Every other call

Attach the token on all protected routes:

```
POST /api/bills
Authorization: Bearer eyJ...
Content-Type: application/json

{ ...bill row... }
```

Your server must answer **`401 { "error": "unauthorized" }`** for a missing,
invalid, or expired token so the app can refresh once and retry. (`403` would be
treated as a permanent error.)

## Endpoint reference

### GET `/api/health` (setting: `api_health_endpoint`)

Reachability probe called at app start and from the Settings → Backend Sync
"Test" button. Public (no token needed).

```
200 { "status": "ok" }
```

Any `2xx` body counts; non-2xx/network error = server unreachable.

---

### POST `/api/bills` (setting: `api_endpoint_bills`)

The app posts the **whole locally-stored bill row** (snake_case) whenever a
invoice is generated, and retries until `2xx`.

Example payload (all fields the app sends today):

```json
{
  "id": 12345,
  "transaction_id": 9876,
  "bill_number": "INV-00042",
  "company_name": "DRP Demo Charging Co.",
  "shift_id": 2,
  "rate_per_kwh": 15,
  "energy_kwh": 12.345,
  "subtotal": 185.18,
  "tax_percent": 13,
  "tax_amount": 24.07,
  "service_fee": 0,
  "service_charge": 0,
  "soc_start": 40,
  "soc_end": 80,
  "rate_name": "Day (08:00-22:00)",
  "total": 209.25,
  "created_at": "2026-08-02T10:00:00.000Z",
  "customer_id": "CUST-0001",
  "customer_name": "Aarav Shrestha",
  "customer_pan": "PAN-1001",
  "customer_address": "Lalitpur",
  "customer_vehicle": "BA1JA1234",
  "max_power_kw": 7.2,
  "avg_power_kw": 6.1,
  "last_power_kw": 5.8,
  "meter_energy_start_kwh": 75881.96,
  "meter_energy_end_kwh": 75894.31,
  "synced": 0,
  "server_bill_id": null
}
```

Your server should be **lenient** — accept it however you like our fields to map.

**Response — important**: to record which id the server assigns, return one of:

```json
{ "id": 50112 }                    // or
{ "bill_id": "BS-50112" }          // or
{ "server_bill_id": 50112 }        // any may also sit inside { "data": {...} }
```

The app saves it to `bills.server_bill_id`, so receipts can link back to your
record. If your response is `2xx` without such a field, the app simply keeps
`server_bill_id` empty (no error).

**Idempotency**: your server will see the *same* bill posted several times when
the network blips (2xx lost in transit). Dedupe on `bill_number` / your own id —
the reference returns `200 duplicate` for the same `bill_number`.

---

### POST `/api/transactions` (setting: `api_endpoint_transactions`)

The app appends the **whole transaction row** when a session closes (or when it
re-queues a closing after an outage).

```json
{
  "id": 50,
  "charger_id": "MS-0018",
  "connector_id": 1,
  "ocpp_tx_id": 4096,
  "started_at": "2026-07-26T11:41:11.000Z",
  "stopped_at": "2026-07-26T12:06:36.000Z",
  "duration_sec": 1499,
  "energy_kwh": 16.747,
  "soc_start": 40,
  "soc_end": 80,
  "customer_id": "CUST-0001",
  "customer_name": "Aarav Shrestha",
  "status": "stopped",
  "flagged": 0,
  "flag_reason": null,
  "billed": 1,
  "synced": 0,
  "max_power_kw": 7.1,
  "avg_power_kw": 6.4,
  "last_power_kw": 5.9,
  "meter_energy_start_kwh": 75881.96,
  "meter_energy_end_kwh": 75894.31,
  "server_data": "{ ...full latest server payload as a JSON string... }"
}
```

Accept it as-is; echoing `{ "id": 55, "app_transaction_id": 50 }` is nice-to-have.

---

## POST /api/logs (setting: `api_endpoint_logs`)

The app streams every safe CSMS event (boot, snapshot, status transition,
transaction_started, meter, transaction_stopped — heartbeats excluded per config)
as a single JSON row:

```json
{
  "id": 300,
  "ts": "2026-08-02T06:12:44.000Z",
  "charger_id": "MS-0018",
  "type": "meter",
  "payload": "{ ...the raw event object, as JSON-string... }"
}
```

High volume (~3/minute/connector while charging). Local log rows are pruned
after 30 days, and sent-queue rows after 30 days too.

---

## GET /api/company

Used by the app's **Branding & Invoice** settings → "Fetch from API" button, and
optionally at startup:

```json
{
  "company_name": "DRP Charging Co",
  "company_address": "Demo St 123, Kathmandu",
  "company_phone": "+977-1-0000000",
  "company_email": "billing@demo.example",
  "branding_logo": "https://…/logo.png",     // optional; retrieved once then base64
  "invoice_logo":   "https://…/invoice.png",  // optional; same
  "invoice_prefix": "INV"                      // applies the app's bill prefix when set
}
```

`invoice_prefix` — also `bill_prefix` or `prefix` — sets the running invoice
prefix. The app applies it via the Branding screen save.

## GET /api/customers/search?q=

Real-time autocomplete when the operator types in the charger's customer field.

```json
[ { "customer_id": "CUST-0001", "customer_name": "Aarav Shrestha",
    "customer_pan": "PAN-1001", "customer_address": "Lalitpur",
    "customer_vehicle": "BA 1 JA 1234" } ]
```

When this endpoint is configured, an operator must pick a customer before a
session can start; the fields are copied to the transaction and onto the bill.

## GET /api/bill/template

Optional "Custom" bill format. Returns an **HTML string** with `{{placeholders}}`.

Supported placeholders (replace literally):

```
{{customer_name}} {{customer_id}} {{customer_pan}} {{customer_address}} {{customer_vehicle}}
{{company_name}} {{bill_number}} {{created_at}}
{{charger_id}} {{connector_id}}
{{energy_kwh}} {{rate_per_kwh}} {{subtotal}} {{tax_percent}} {{tax_amount}}
{{service_fee}} {{service_charge}} {{total}}
{{soc_start}} {{soc_end}} {{soc_delta}}
{{started_at}} {{stopped_at}} {{duration_sec}}
{{rate_name}} {{max_power_kw}} {{avg_power_kw}} {{last_power_kw}}
{{meter_energy_start_kwh}} {{meter_energy_end_kwh}}
{{show_logo_on_bill}} {{invoice_logo}} {{branding_logo}} {{logo_data}}
```

A working copy ships as [`reference-server/bill-template.html`](../reference-server/bill-template.html).

## GET /api/bill/details?bill_number=INV-00042

When the Custom format is selected, the app fetches the bill from here before
rendering and **merges the response over the local bill** (server values win),
then renders it with the template above. Wrapper formats accepted: flat `{...}`,
`{ "data": {...} }`, or `{ "bill": {...} }`. Return `404` if unknown — the app
falls back to the local bill. Like every call, a `401` makes the app re-login
and retry once.

## GET /api/bill/next-number

The app pre-fetches a server-assigned next invoice number and caches it (so
billing never blocks), using its local sequence while offline.

```json
{ "bill_number": "INV-00007" }   // also { next_bill_number } / { number } / nested { "data": {...} }
```

Any of `bill_number`, `next_bill_number`, `number` (root or `data`) is matched.
When a server number is cached it overrides the local counter until depleted.

## Do's & Dont's (for your implementer)

- **Do** answer every POST with a fast `2xx` — the app treats network loss as
  an upstream outage, not a record rejection.
- **Do** return a stable unique `id` from `/api/bills` — this is the only
  response field the app persists (`bills.server_bill_id`).
- **Do** make your POSTs idempotent — dedupe on `bill_number`.
- **Do** answer `401` (not `403`) for missing/expired tokens so the auto-refresh works.
- **Don't** rely on the app sending only your expected fields — it forwards
  everything it has stored and tolerates unknown fields in responses.

The contract is pinned by [`reference-server/conformance-check.js`](../reference-server/conformance-check.js),
which your backend fails when any of the 13 assertions break.