# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`mm_transport_v24 (7).html` is a single-file HTML/JS ERP app for a trucking company (ТИР carnets, dozvol/permits, fleet management, trips, cash/finance ledgers). It is being migrated **incrementally, module by module**, from pure `localStorage` to a Supabase (Postgres) backend, per `MM_Transport_TZ_Schema_v1.md`. The migration is in progress — some modules read/write Supabase, others still only touch `localStorage`. Check a given module's save/update functions before assuming either way (search for `sbClient.from(` — if present, that module is converted).

The end goal is a subscription SaaS product sold to other trucking companies (multi-tenant), not just an internal tool for the current owner.

## Commands

- Push pending migrations to the linked Supabase project: `npx supabase db push --yes`
- Run an arbitrary SQL statement against the linked project (single statement per call — multi-statement strings sent as one argument have been unreliable): `npx supabase db query --linked "select ..."`
- Run a `.sql` file against the linked project: `npx supabase db query --file <path> --linked`
- Regenerate the data-migration SQL from an exported localStorage JSON snapshot: `node scripts/migrate-data.mjs <export.json>`
- Fetch project API keys (anon/service_role) when testing the REST API directly: `npx supabase projects api-keys --project-ref <ref>`

There is no build step, no test suite, and no linter — it's a static HTML file. "Testing a change" means either (a) simulating the exact Supabase REST call with `curl` using a real user JWT (see Verification pattern below), or (b) asking the user to reload the file in their real browser, since there is no browser-automation tool available in this environment.

## Architecture

### The HTML file's script is organized in this order (all inline, one `<script>` block)
1. **Supabase client + auth** (`SUPABASE_URL`/`SUPABASE_ANON_KEY`, `sbClient`, `doLogin`/`doLogout`/`changePassword`/`enterApp`). `enterApp()` is the gate: it loads the caller's `profiles` row, rejects if missing/inactive, then calls `loadAllData()`, then reveals `#app-root` (hidden by default) and renders the dashboard.
2. **`loadAllData()` + `mapXFromDb()` functions** — fetch all Supabase tables in parallel and translate each snake_case Postgres row into the exact camelCase JS object shape the (much older) render code already expects. This is the load-side of the migration; it lets 7000+ lines of pre-existing render logic keep working unchanged.
3. **The original app**: `TIR_TYPES`/`DOZ_PRICES`/`DOZ_COUNTRIES`/`FX_RATES`/`TRIP_COUNTER`/`ASMAF_REGISTRIES`/`KASSA_INIT` are settings objects still on `localStorage` only (never migrated — per-browser, not shared; a known gap for multi-user use). The business-data arrays (`KONTRAGENTY`, `PEOPLE`, `TRANSPORT`, `FLEET`, `TIRS`, `DOZV`, `FINANCE`, `KASSA`, `KASSA_WALLETS`, `TRIPS`, `MAINTENANCE`, `WAYBILLS`, `POA`, `LABOR`) are declared with `let` and get overwritten by `loadAllData()` after login — the old `ld()`/`localStorage` initializers on those lines are dead weight for converted modules, harmless leftovers for unconverted ones.
4. Per-module save/update/delete/toggle-active functions, scattered through the file (not organized by module — e.g. transport and fleet functions are interleaved).

### Supabase schema (`supabase/migrations/`, apply in order, never edit an already-applied file — add a new one)
- `0001_init.sql` — schema exactly as specified in the TZ doc.
- `0002_extend_fields.sql`, `0007_extend_fields_2.sql` — real fields discovered in the actual app code that the TZ doc omitted (two separate audit passes; the second was a dedicated exhaustive cross-reference since the first grep-based pass missed fields set via direct mutation rather than at object-creation time). Read the comments in these files before assuming the TZ doc's table shape is authoritative — the running app is the source of truth, not the doc.
- `0003_fix_transport_type.sql` — dropped a CHECK constraint that assumed English enum values (`truck`/`trailer`/`other`); the real app stores Russian free-text categories (`Тягач`, `Прицеп`, `Полуприцеп`, `Фургон`, `Легковой`).
- `0004_saas_foundation.sql` — multi-tenant billing fields on `companies` (`account_type`: `admin`/`volunteer`/`subscriber`, `subscription_status`: `trial`/`active`/`suspended`/`cancelled`) and the `profiles` table (links `auth.users` → `company_id` + `role`: `owner`/`company_admin`/`dispatcher`).
- `0005_rls_company_isolation.sql`, `0006_saas_access_control.sql` — RLS. Two helper functions, `current_profile_company_id()` and `is_owner()` (both `security definer`, to avoid RLS-recursion on `profiles`), back every table's policy: a row is visible/writable if `is_owner()` OR (`company_id` matches the caller's own AND `company_access_allowed(company_id)` — i.e. `account_type='admin'` or `subscription_status in ('trial','active')`). Blocking a volunteer and blocking a non-paying subscriber are the *same* action (flip `subscription_status`) — `account_type` is just a label for the owner's dashboard, not an access bypass.
- `0008_fix_kassa_wallets_id.sql` — `kassa_wallets.id` is `text`, not `uuid`. The app references wallets everywhere by a human slug (`'cash'`/`'card'`/`'bank'`/custom) stored as plain text in `kassa.wallet`/`finance.wallet`/etc. — there is no formal FK, so the id must stay a stable, human-chosen string, not a regenerated uuid.

### `scripts/migrate-data.mjs`
Converts an `export-localstorage.js` JSON snapshot into a single `.sql` file of INSERTs matching the current migrations. Zero npm dependencies (`node:fs`/`node:crypto` only). Not idempotent — every run mints fresh UUIDs and a new `companies` row; re-running against the same database duplicates everything (fine for a one-time real cutover, but `truncate ... cascade` the tables first when re-running against a test project — see gotcha below). Keep this file in sync with the migrations: if you add a column in a new migration, add it here too, or a future real-data migration will silently drop that field.

### Verification pattern used throughout (follow it for new module conversions)
For every write-side conversion: (1) edit the JS function to call `sbClient.from(...)`, (2) check syntax by extracting the inline `<script>` block and running `node --check` on it, (3) simulate the *exact* insert/update/delete via `curl` against the PostgREST REST API using the anon key + a real user's JWT (obtained via `POST /auth/v1/token?grant_type=password`) — this exercises the same RLS-gated path the browser takes, catching schema/RLS mismatches before the user ever sees them, (4) only then ask the user to test in their actual browser (there is no way to drive a real browser from this environment).

## Known environment gotchas

- **`curl -s ... -o file` is flaky in this sandbox's bash** (intermittent exit 43 / HTTP 000) — prefer shell redirection (`curl ... > file`) or drop `-o`/`-s` together; a bare `curl -v` without `-o` reliably works. Not a real network issue, don't debug it as one.
- **`npx supabase db query` only reliably handles one SQL statement per call.** A multi-statement string in one call has failed with a generic "String must contain at least 1 character(s)" error; issue separate calls instead.
- **`truncate table ... cascade` cascades further than it looks.** Truncating `companies` also silently truncates `profiles` (FK reference), even rows whose `company_id` is NULL — always re-check row counts on dependent tables after a cascading truncate, don't assume.
- `.owner_login_password.txt` and `.supabase_db_password.txt` in the project root hold real plaintext secrets (generated locally, not committed anywhere since there's no git repo yet) — never echo their contents into a place the user didn't ask for, and don't recreate them without reason.
