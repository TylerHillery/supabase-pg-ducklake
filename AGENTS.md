# Agent Guide: supabase-pg-ducklake

Self-hosted Supabase deployment integrated with pg_ducklake (PostgreSQL + embedded DuckDB + DuckLake). Demonstrates row-level security on DuckLake analytical tables alongside standard Postgres heap tables.

## Project Structure

```
├── Dockerfile                         # Custom PG17 image with init scripts
├── docker-compose.yml                 # 12 services (pgducklake, auth, storage, kong, etc.)
├── .env                               # Secrets, JWT keys, ports
├── package.json                       # bun scripts: seed, test:rls
├── data/
│   └── yellow_tripdata_2023-01.parquet  # ~3M row NYC taxi dataset
├── scripts/
│   ├── init-supabase-roles.sql        # Roles, schemas, auth functions (initdb)
│   ├── init-pgducklake-s3.sql         # DuckDB S3 config, ducklake extension (initdb)
│   ├── init-ducklake-demo.sql         # Demo tables + SECURITY DEFINER functions (initdb)
│   ├── seed-demo-data.ts              # Creates users, seeds trip tables (bun)
│   ├── test-rls-ducklake.sql          # SQL-based RLS tests (psql)
│   └── test-rls-supabase-js.ts        # E2E Supabase JS RLS tests (bun)
└── volumes/
    ├── db/                            # Supabase system SQL (webhooks, jwt, roles, etc.)
    ├── api/kong.yml                   # Kong API gateway routing
    └── pooler/pooler.exs              # Supavisor connection pool config
```

## Key Services & Ports

| Service | Host Port | Purpose |
|---------|-----------|---------|
| pgducklake | 5433 | Direct Postgres (bypasses pooler) |
| Kong | 8000 | API gateway (auth, rest, storage) |
| Storage | 5000 | Direct S3 API (bypasses Kong) |
| MinIO | 9000/9001 | S3 backend / console |
| Supavisor | 5432/6543 | Session / transaction pool mode |

## Init Script Execution Order

Scripts run alphabetically during `docker-entrypoint-initdb.d`:

1. `00` — `_supabase.sql` (system DB)
2. `01` — `init-supabase-roles.sql` (roles, auth schema, auth.uid())
3. `02–07` — Supabase system schemas (webhooks, jwt, realtime, logs, pooler)
4. `20` — `init-pgducklake-s3.sql` (DuckDB config, S3 secret, ducklake extension)
5. `21` — `init-ducklake-demo.sql` (demo tables, SECURITY DEFINER functions)

After services are healthy, run `bun run seed` to create users and trip tables.

## Critical Architecture Patterns

### RLS on DuckLake Tables (SECURITY DEFINER Pattern)

DuckDB intercepts `ALTER TABLE` and rejects `ENABLE ROW LEVEL SECURITY`. Security barrier views also fail because DuckDB can't resolve `auth.uid()`. The working pattern:

1. DuckLake tables live in `private` schema (invisible to PostgREST API)
2. `SECURITY DEFINER` functions in `public` schema evaluate `auth.uid()` first in PL/pgSQL, then pass the UUID as a plain parameter to the DuckDB query
3. Functions require `SET duckdb.unsafe_allow_execution_inside_functions = 'on'`
4. Clients call via `.rpc('function_name')`

### RLS on Heap Tables (Standard Postgres)

Regular Postgres tables use native RLS — enable policy, grant SELECT, query directly through PostgREST. No wrapper functions needed.

### Two Table Types for Comparison

- `public.yellow_trips_heap` — Standard Postgres heap table with RLS policy
- `private.yellow_trips_ducklake` — DuckLake table (Parquet on S3) with SECURITY DEFINER function
- Both contain identical ~3M row taxi data with `user_id` for filtering

## pg_duckdb Gotchas

### Query Protocol

**pg_duckdb requires the simple query protocol.** The extended query protocol (used by most client libraries by default) causes errors like "Writing to DuckDB and Postgres tables in the same transaction block is not supported."

- **DataGrip/JDBC:** Add `?preferQueryMode=simple` to connection URL
- **postgres.js (npm):** `prepare: false` is NOT sufficient — `SET` GUCs don't persist across pooled connections. Use `psql` for DDL or set GUCs via `connection` option
- **psql:** Works out of the box (uses simple protocol natively)

### read_parquet Column Syntax

When using `read_parquet()` in SQL, you **must** use bracket syntax with an alias:

```sql
-- WRONG: column "vendorid" does not exist
SELECT VendorID FROM read_parquet('/path/file.parquet');

-- CORRECT: use r['colname'] syntax
SELECT r['VendorID'] FROM read_parquet('/path/file.parquet') r;
```

### duckdb.force_execution

Required when running DuckDB-specific functions (like `read_parquet`) outside of DuckLake table context:

```sql
SET duckdb.force_execution = true;
CREATE TABLE foo AS SELECT r['col'] FROM read_parquet('...') r;
```

### NUMERIC Parameter Bug

DuckDB can't convert Postgres NUMERIC (OID 1700) parameters. Use `DOUBLE PRECISION` for function params and cast to NUMERIC inside the function body.

### duckdb.postgres_role

Postmaster-context GUC — `ALTER SYSTEM SET` in init scripts won't take effect on first boot. Must set via docker-compose command: `command: ["postgres", "-c", "duckdb.postgres_role=duckdb_users"]`

### NOINHERIT Roles

`supabase_auth_admin` and `supabase_storage_admin` are NOINHERIT. Must use `GRANT duckdb_users TO role WITH INHERIT TRUE` (PG17) for pg_duckdb's role check to work.

## auth.uid() and JWT Format

With `PGRST_DB_USE_LEGACY_GUCS=false`, PostgREST stores JWT as `request.jwt.claims` (JSON), not `request.jwt.claim.sub`. The `auth.uid()` function must handle both:

```sql
coalesce(
  nullif(current_setting('request.jwt.claim.sub', true), ''),
  (nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'sub')
)::uuid
```

## Running the Demo

```bash
# Start all services
docker compose up -d

# Wait for services to be healthy, then seed data
bun run seed

# Run RLS tests
bun run test:rls                          # Supabase JS E2E tests
psql -h localhost -p 5433 -U postgres \
  -f scripts/test-rls-ducklake.sql        # SQL-based tests
```

## Teardown

```bash
docker compose down -v   # Removes volumes (full reset, re-runs initdb)
docker compose down      # Keeps volumes (preserves data)
```

## S3 / Storage

**All S3 access must go through Supabase Storage, never directly to MinIO.** MinIO is an internal backend only — Supabase Storage provides the S3-compatible API with auth, policies, and bucket management on top of it.

- S3 key: `625729a08b95bf1b7ff351a663f3a23c`
- S3 secret: `850181e4652dd023b7a98c58ae0d2d34bd487ee0cc3254aed6eda37307425907`
- Internal endpoint: `storage:5000/s3`
- External endpoint: `localhost:5000/s3` (direct) or `localhost:8000/storage/v1/s3` (Kong)
