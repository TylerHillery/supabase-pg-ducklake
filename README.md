> [!WARNING]
> This codebase is primarily AI-generated for demo and POC purposes.

# Supabase + pg_ducklake

PostgreSQL with embedded DuckDB ([pg_ducklake](https://github.com/duckdb/pg_ducklake)) running on the Supabase self-hosted stack. DuckLake tables store data as Parquet files in S3 (MinIO) via Supabase Storage, while metadata lives in PostgreSQL.

Includes full Supabase Auth (GoTrue) integration with row-level security on DuckLake tables using the [SECURITY DEFINER function pattern](RLS_TESTING.md).

## Quick Start

```bash
cp .env.example .env
docker compose up --build
```

On first boot the init scripts will:
1. Create the `pg_duckdb` extension and install the `ducklake` DuckDB extension
2. Create all Supabase roles, system schemas, and extensions (`uuid-ossp`, `pgcrypto`)
3. Create `auth.uid()`, `auth.role()`, `auth.email()` functions (compatible with both legacy and non-legacy PostgREST GUCs)
4. Create a `duckdb_users` group role and grant membership to `authenticated`, `supabase_auth_admin`, and `supabase_storage_admin`
5. Configure a DuckDB S3 secret pointing at Supabase Storage (`storage:5000/s3`)
6. Set `ducklake.default_table_path = 's3://ducklake/'`

GoTrue (Auth) runs its own 67 migrations to create the `auth.users` table and related infrastructure.

A `storage-createbucket` init container automatically creates the `ducklake` bucket in Supabase Storage once the service is healthy.

## Services

| Service | URL | Description |
|---------|-----|-------------|
| Supabase Studio | http://localhost:8000 | Dashboard |
| Auth (GoTrue) | http://localhost:8000/auth/v1/ | Authentication API (via Kong) |
| PostgREST | http://localhost:8000/rest/v1/ | REST API (via Kong) |
| PostgreSQL (direct) | localhost:5433 | Direct connection, bypasses Supavisor |
| PostgreSQL (pooled) | localhost:5432 | Via Supavisor (session mode) |
| Supabase Storage | localhost:5000 | Direct S3 API |
| MinIO Console | http://localhost:9001 | S3 object browser (minioadmin/minioadmin) |

## Usage

### Create a DuckLake table

Connect directly to the database:

```bash
psql -h localhost -p 5433 -U postgres
# Password: your-super-secret-and-long-postgres-password
```

Create a table backed by S3:

```sql
CREATE TABLE test(id int, name text) USING ducklake;
```

Insert and query (these must be **separate statements** — pg_duckdb does not support writing to DuckDB and Postgres tables in the same transaction):

```sql
INSERT INTO test VALUES (1, 'hello'), (2, 'world'), (3, 'ducklake');
```

```sql
SELECT * FROM test;
```

```
 id |   name
----+----------
  1 | hello
  2 | world
  3 | ducklake
```

### Verify S3 storage

Check that DuckLake is storing data in S3 via the metadata table:

```sql
SELECT table_name, path, path_is_relative
FROM ducklake.ducklake_table
WHERE table_name = 'test';
```

```
 table_name |            path            | path_is_relative
------------+----------------------------+------------------
 test       | s3://ducklake/public/test/ | f
```

Open the MinIO Console at http://localhost:9001 (minioadmin/minioadmin) and browse `stub/ducklake/` to see the Parquet files. (Supabase Storage writes to the `stub` backend bucket in MinIO, namespaced under the `ducklake/` prefix.)

### Query via PostgREST

DuckLake tables in the `public` schema are accessible through the REST API once granted:

```sql
GRANT SELECT, INSERT, UPDATE, DELETE ON test TO anon, authenticated, service_role;
NOTIFY pgrst, 'reload schema';
```

Then query via curl:

```bash
ANON_KEY="<your-anon-key-from-.env>"

curl -s \
  -H "apikey: $ANON_KEY" \
  -H "Authorization: Bearer $ANON_KEY" \
  http://localhost:8000/rest/v1/test
```

```json
[{"id":1,"name":"hello"},{"id":2,"name":"world"},{"id":3,"name":"ducklake"}]
```

### Row-Level Security on DuckLake Tables

Native PostgreSQL RLS does not work on DuckLake TAM tables — DuckDB intercepts `ALTER TABLE` and rejects `ENABLE ROW LEVEL SECURITY`. Instead, use the **SECURITY DEFINER function pattern** (same as Supabase recommends for Foreign Data Wrappers):

1. Keep DuckLake tables in a **`private` schema** (not exposed via API)
2. Create **`SECURITY DEFINER` functions** in `public` that filter by `auth.uid()`
3. Clients call the functions via `.rpc()`

```sql
-- Private schema for DuckLake tables
CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM anon, authenticated, service_role;

SET search_path TO private, public;
CREATE TABLE private.transactions (
  user_id UUID NOT NULL,
  amount NUMERIC(10,2) NOT NULL,
  description TEXT
) USING ducklake;
RESET search_path;

-- SECURITY DEFINER function: evaluates auth.uid() in Postgres,
-- passes the UUID as a parameter to DuckDB
CREATE OR REPLACE FUNCTION public.get_my_transactions()
RETURNS TABLE (user_id UUID, amount NUMERIC(10,2), description TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
SET duckdb.unsafe_allow_execution_inside_functions = 'on'
AS $$
DECLARE
  uid UUID := auth.uid();
BEGIN
  RETURN QUERY
  SELECT t.user_id, t.amount, t.description
  FROM private.transactions t
  WHERE t.user_id = uid;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_my_transactions() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_transactions() TO authenticated;
```

```typescript
// Client usage
const { data } = await supabase.rpc('get_my_transactions')
```

See [RLS_TESTING.md](RLS_TESTING.md) for the full explanation of why this is necessary, what alternatives were tried, and detailed setup instructions.

### Running the tests

```bash
# SQL test (simulates PostgREST JWT context via SET LOCAL)
psql -h localhost -p 5433 -U postgres -f scripts/test-rls-ducklake.sql

# Supabase JS end-to-end test (real auth: signs up users, inserts data, queries)
bun scripts/test-rls-supabase-js.ts
```

## Architecture

```
Supabase Client (JWT)
  |
  v
Kong (:8000) --- Auth (GoTrue :9999) --- auth schema in PostgreSQL
  |
  v
PostgREST (:3000) --- .rpc("get_my_transactions")
  |
  v
PostgreSQL (pg_ducklake)
  |  SECURITY DEFINER function evaluates auth.uid(),
  |  queries DuckLake table with plain UUID parameter
  |
  v
DuckDB (embedded)
  |  S3 protocol (via DuckDB httpfs)
  |  Endpoint: storage:5000/s3
  |
  v
Supabase Storage (:5000)
  |  S3 protocol (backend)
  |
  v
MinIO (:9000)
  +-- stub/ducklake/<schema>/<table>/  <- Parquet files
```

## Init Script Order

The Dockerfile copies scripts into `/docker-entrypoint-initdb.d/` where they run alphabetically on first boot:

| Order | File | What it does |
|-------|------|-------------|
| 00 | `_supabase.sql` | Creates `_supabase` database |
| 01 | `init-supabase-roles.sql` | All Supabase roles, schemas, extensions, auth functions, grants |
| 02 | `webhooks.sql` | `supabase_functions` schema and http_request trigger |
| 03 | `roles.sql` | Sets passwords for all roles |
| 04 | `jwt.sql` | JWT secret GUCs on postgres database |
| 05 | `realtime.sql` | `_realtime` schema |
| 06 | `logs.sql` | `_analytics` schema in `_supabase` database |
| 07 | `pooler.sql` | `_supavisor` schema in `_supabase` database |
| 20 | `init-pgducklake-s3.sql` | `duckdb_users` group role, ducklake catalog grants, S3 secret, default table path |

The base image (`pgducklake/pgducklake:17-main`) runs its own scripts at `0001-*` and `0002-*` before these.

## Known Limitations

- **No native RLS on DuckLake tables**: DuckDB intercepts `ALTER TABLE` and rejects `ENABLE ROW LEVEL SECURITY`. Use the SECURITY DEFINER function pattern instead. See [RLS_TESTING.md](RLS_TESTING.md).
- **Mixed transactions**: pg_duckdb does not allow writing to DuckDB and Postgres tables in the same transaction block. Run DuckLake INSERTs as separate statements.
- **Identity columns**: `GENERATED ALWAYS AS IDENTITY` is not supported by DuckDB. Manage IDs in application code or use a Postgres sequence separately.
- **NUMERIC function parameters**: DuckDB cannot convert Postgres `NUMERIC` (OID 1700) parameters. Use `DOUBLE PRECISION` in function signatures and cast inside the body.
- **Global DDL interception**: pg_duckdb intercepts `ALTER TABLE`, `DROP TABLE IF EXISTS`, etc. on ALL tables (not just DuckLake). Any role that runs DDL needs `duckdb.postgres_role` membership.
- **`duckdb.postgres_role` is postmaster-context**: Requires a Postgres restart. Set via `docker-compose.yml` command line for first-boot, and `ALTER SYSTEM SET` for persistence.
- **NOINHERIT roles**: Supabase roles like `supabase_auth_admin` are `NOINHERIT`. Group role grants must use `WITH INHERIT TRUE` (PG17+) or grants must be made directly to each role.
- **Supabase Meta `octet_length` error**: Studio's table viewer may error on DuckLake tables because DuckDB's `octet_length()` only supports BLOB/BIT, not VARCHAR. Querying directly via SQL or PostgREST works fine.
- **`pg_net` not available**: The pgducklake base image doesn't include `pg_net`. Supabase webhooks that depend on it won't function.
- **DataGrip**: Must use `preferQueryMode=simple` JDBC parameter. The extended query protocol causes "Writing to DuckDB and Postgres tables in the same transaction block" errors. JDBC URL: `jdbc:postgresql://localhost:5433/postgres?preferQueryMode=simple`

## Teardown

```bash
docker compose down -v
```
