# VoltDesk / DRP reference backend

A small, dependency-light HTTP server that implements the exact REST contract
the desktop app expects. Use it as the starter for your own backend, or run it
as-is to connect the app end-to-end.

It has **no framework** and, on Node >= 22.5, **no dependencies at all** (uses the
built-in `node:sqlite`). It intentionally keeps SQLite persistence so posted
bills/logs/transactions survive a restart:

```
reference-server/
  server.js               the entire API (see routes below)
  bill-template.html      starter custom bill format (served by /api/bill/template)
  conformance-check.js    acts like the app against your running server, PASS/FAIL
  data/data.db            created on first run (auto-ignored via *.db)
```

## Run it

```bash
cd reference-server
node server.js            # needs Node >= 22.5 (built-in sqlite), or:
# npm i better-sqlite3    # older Node fallback
```

You'll see:

```
DRP reference backend listening on http://0.0.0.0:8080
  db:      ...\reference-server\data\data.db
  auth:    enabled (admin / admin123, token TTL 86400s)
```

## Config (env vars)

| Env | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | listen port |
| `HOST` | `0.0.0.0` | bind address |
| `ADMIN_USER` | `admin` | login username |
| `ADMIN_PASS` | `admin123` | login password |
| `AUTH_DISABLED` | unset | `1` turns off the token check (device still sends a token if `api_key` is set) |
| `TOKEN_TTL` | `86400` | token lifetime in seconds (`expires_in`) |
| `DB_PATH` | `./data/data.db` | SQLite file; use an absolute path or a subpath |

## Endpoints

| Method | Path | Purpose (app setting that maps to it) |
|---|---|---|
| POST | `/api/login` | token auth (`api_login_endpoint`) |
| GET | `/api/health` | reachability, startup check + Settings test (`api_health_endpoint`) |
| POST | `/api/bills` | ingest a bill; returns the id the app stores as `server_bill_id` (`api_endpoint_bills`) |
| POST | `/api/transactions` | ingest a completed session (`api_endpoint_transactions`) |
| POST | `/api/logs` | ingest a raw CSMS event (`api_endpoint_logs`) |
| GET | `/api/company` | company info incl. `invoice_prefix` (`api_company_info_endpoint`) |
| GET | `/api/customers/search?q=` | customer autocomplete (`api_customer_search_endpoint`) |
| GET | `/api/bill/template` | custom HTML bill format (`api_bill_format_endpoint`) |
| GET | `/api/bill/details?bill_number=` | stored bill details for Custom rendering (`api_bill_details_endpoint`) |
| GET | `/api/bill/next-number` | server-assigned next invoice number (`api_bill_number_endpoint`) |

See `../docs/backend-api.md` for every request/response shape and the app-side
settings table, and `docs/BACKEND_SETUP.md` for the step-by-step app wiring.

## Quick curl tour

```bash
BASE=http://localhost:8080

# login -> token
TOKEN=$(curl -s $BASE/api/login -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin123"}' | tee /dev/stderr | \
  grep -o '"access_token":"[^"]*"' | cut -d'"' -f4)
AUTH="Authorization: Bearer $TOKEN"

curl -s $BASE/api/health
curl -s -H "$AUTH" $BASE/api/company
curl -s -H "$AUTH" "$BASE/api/customers/search?q=bin"
curl -s -H "$AUTH" $BASE/api/bill/next-number
curl -s -H "$AUTH" $BASE/api/bill/details?bill_number=INV-00001
curl -s -H "$AUTH" -X POST -H 'Content-Type: application/json' \
  -d '{"bill_number":"INV-00001","total":209.25}' $BASE/api/bills
```

## Verify with the conformance check

Start the server, then from the `reference-server/` folder:

```bash
node conformance-check.js
```

Every endpoint is exercised the way the desktop app does (login → bearer token,
ingest a bill → read it back, next-number, company, customer search, template,
transactions, logs, idempotent retry). Expect `13/13 checks passed`; exits
non-zero on any failure.

> A trailing `Assertion failed: ... async.c` / abort-then-exit message on
> Windows is a Node 24 shutdown artifact from force-killing the shell process,
> not a server error — ignore it in interactive Ctrl+C use.

## Exchange a live checkout for your own backend

Copy `server.js` and adapt the handlers:

1. Replace `node:sqlite` with your real datastore (the handlers are thin).
2. Keep the **response contracts** — especially: bills POST returns an `id`
   (the app writes it to `bills.server_bill_id`), `next-number` returns
   `{ bill_number }`, `login` returns `access_token` (+ `expires_in`), and every
   guarded route answers `401` on a missing/expired token so the app re-logins
   and retries.
3. Keep the POST endpoints tolerant: the app sends the *whole* local row and
   treats any 2xx as accepted.