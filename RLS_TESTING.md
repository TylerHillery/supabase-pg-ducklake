# Row-Level Security on DuckLake TAM Tables

## TL;DR

**Native PostgreSQL RLS does not work on DuckLake TAM tables.** DuckDB intercepts `ALTER TABLE` commands and rejects RLS-related ones. The working solution uses the same pattern Supabase recommends for [Foreign Data Wrappers](https://supabase.com/docs/guides/database/extensions/wrappers/overview#security): keep DuckLake tables in a **private schema** and expose them through **`SECURITY DEFINER` functions** that filter by `auth.uid()`.

This document explains the problem, why each alternative fails, the working solution, and everything we learned getting it to work with Supabase Auth end-to-end.

---

## Background: How Supabase Auth and RLS Work

Supabase Auth uses the `auth` schema in your Postgres database to store user tables and other information. For security, this schema is not exposed on the auto-generated API.

When a user makes an API request through PostgREST, the flow is:

1. The Supabase client sends a JWT (containing the user's UUID in the `sub` claim)
2. PostgREST validates the JWT and sets session-level GUC variables:
   - `SET LOCAL ROLE authenticated` (or `anon` for unauthenticated requests)
   - `SET LOCAL request.jwt.claims = '<json>'` (the full JWT payload)
3. The SQL query runs under the `authenticated` role
4. PostgreSQL's RLS policies evaluate `auth.uid()` — which reads the UUID from the JWT GUC — and filter rows accordingly

On a **normal PostgreSQL table**, this is seamless: you `ENABLE ROW LEVEL SECURITY`, create a policy like `USING (user_id = auth.uid())`, and Postgres enforces it transparently. The application code just queries the table and only sees its own rows.

DuckLake TAM tables break this flow at multiple points.

---

## Why RLS Cannot Work Directly on DuckLake TAM Tables

DuckLake uses PostgreSQL's [Table Access Method (TAM)](https://www.postgresql.org/docs/current/tableam.html) API, which means `CREATE TABLE ... USING ducklake` creates a table that *looks* like a normal Postgres table but is actually backed by DuckDB (which stores data as Parquet files). The pg_duckdb extension intercepts SQL commands and routes them to DuckDB's query engine.

This creates three fundamental incompatibilities with PostgreSQL RLS:

### 1. `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` is intercepted and rejected

```sql
CREATE TABLE public.transactions (
  user_id UUID NOT NULL,
  amount NUMERIC(10,2) NOT NULL,
  description TEXT
) USING ducklake;

ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;
-- ERROR: (PGDuckDB/duckdb_alter_table_trigger_cpp) Not implemented Error:
--   SAVEPOINT and subtransactions are not supported in DuckDB
```

pg_duckdb intercepts **all** `ALTER TABLE` commands on DuckLake tables. It doesn't understand `ENABLE ROW LEVEL SECURITY` (this is a PostgreSQL catalog-level concept that has no equivalent in DuckDB), so it rejects it outright. There is no workaround — you cannot enable RLS on a DuckLake TAM table.

### 2. DuckDB cannot resolve PostgreSQL functions in query plans

Even if you could somehow enable RLS, the policy expression `USING (user_id = auth.uid())` would fail at query time. When DuckDB takes over query execution for a DuckLake table, it tries to resolve the **entire** query plan inside its own engine — including any functions referenced in WHERE clauses, view definitions, or RLS policies.

DuckDB has no knowledge of PostgreSQL functions like `auth.uid()`, `current_setting()`, or any PL/pgSQL function. It maintains its own function catalog and will fail with:

```
ERROR: Catalog Error: Scalar Function with name uid does not exist!
```

This means any approach that embeds `auth.uid()` into a query plan that DuckDB will execute is fundamentally broken — not just RLS policies, but also views and CTEs.

### 3. pg_duckdb intercepts DDL globally, not just on DuckLake tables

This isn't an RLS issue per se, but it compounds the problem: pg_duckdb intercepts `ALTER TABLE`, `DROP TABLE IF EXISTS`, and other DDL commands across **all schemas** — even for regular PostgreSQL heap tables. Any role that runs DDL (GoTrue migrations, storage migrations, etc.) must be granted the `duckdb.postgres_role` or it will get permission errors. See [Obstacles](#obstacles-along-the-way) for details.

---

## Approaches We Tried

### Attempt 1: Direct RLS on a DuckLake Table

The standard Supabase RLS pattern — enable RLS on the table, create a policy referencing `auth.uid()`:

```sql
ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;
-- ERROR: SAVEPOINT and subtransactions are not supported in DuckDB
```

**Result: Failed.** DuckDB intercepts the `ALTER TABLE` and rejects it. There is no way to enable RLS on a DuckLake TAM table.

### Attempt 2: Security Barrier View

A `security_barrier` view sits between the user and the DuckLake table, filtering rows via `auth.uid()` in the view definition:

```sql
CREATE VIEW public.transactions_secure
  WITH (security_barrier = true)
  AS SELECT * FROM public.transactions
  WHERE user_id = auth.uid();

GRANT SELECT ON public.transactions_secure TO authenticated;
```

```
ERROR: (PGDuckDB/CreatePlan) Prepared query returned an error:
  Catalog Error: Scalar Function with name uid does not exist!
```

**Result: Failed.** When DuckDB takes over query execution, it tries to resolve `auth.uid()` inside DuckDB's engine. DuckDB doesn't know about PostgreSQL functions, so the query fails.

This would also fail with Postgres 15+'s `security_invoker` views for the same reason — the DuckDB query planner sees the view's WHERE clause and can't resolve the Postgres function regardless of whether the view uses invoker or definer semantics.

### Attempt 3: Security Invoker View (Postgres 15+)

Starting in Postgres 15, views can be created with `security_invoker = true`. This means the view's queries run with the permissions of the **calling user**, not the view owner. Combined with RLS on the underlying table, this is the modern best practice for secure views in Postgres.

```sql
CREATE VIEW public.transactions_view
  WITH (security_invoker = true)
  AS SELECT * FROM public.transactions;
```

**Result: Would fail for the same reason as Attempt 2.** The view doesn't contain `auth.uid()` itself, but:
- The underlying table can't have RLS enabled (Attempt 1)
- If you add a WHERE clause with `auth.uid()`, DuckDB can't resolve it (Attempt 2)
- `security_invoker` only controls *whose permissions* are checked — it doesn't change the fact that DuckDB's query engine can't call PostgreSQL functions

`security_invoker` views are important for regular Postgres tables (and are the recommended approach for views over `auth.users`), but they don't help with DuckLake TAM tables because the problem is at the query engine level, not the permission level.

### Attempt 4: SECURITY DEFINER Functions (FDW Pattern) — Works!

Following Supabase's [recommended pattern for Foreign Data Wrappers](https://supabase.com/docs/guides/database/extensions/wrappers/overview#security), we keep the DuckLake table in a private schema and expose it through PL/pgSQL functions:

```sql
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
```

**Result: Works!**

---

## Why SECURITY DEFINER Functions Work

The key insight is the **separation of execution contexts**. A `SECURITY DEFINER` function runs as its owner (typically the superuser/`postgres` role), not as the calling user. But crucially, PL/pgSQL evaluates expressions in the `DECLARE` block **before** the DuckDB query runs.

Here's what happens step by step:

```
Supabase Client (JWT with user UUID in 'sub' claim)
  |
  v
PostgREST (.rpc("get_my_transactions"))
  |  Sets: role = 'authenticated'
  |  Sets: request.jwt.claims = '{"sub": "<user-uuid>", ...}'
  |
  v
PostgreSQL: public.get_my_transactions()  [SECURITY DEFINER -> runs as postgres]
  |  1. PL/pgSQL DECLARE block runs IN POSTGRES:
  |     uid := auth.uid()  ->  reads current_setting('request.jwt.claims')
  |                         ->  extracts 'sub' from JSON
  |                         ->  resolves to plain UUID value
  |
  |  2. RETURN QUERY runs the SELECT, passing uid as a parameter:
  |     SELECT ... FROM private.transactions WHERE user_id = uid
  |
  v
DuckDB (embedded): receives query with a plain UUID parameter
  |  Scans Parquet files, applies WHERE user_id = $1
  |  Never sees auth.uid() — just a UUID value
  |
  v
Only the calling user's rows are returned
```

This works because:

1. **`auth.uid()` is evaluated by PostgreSQL**, not DuckDB. The `DECLARE` block is pure PL/pgSQL — DuckDB is not involved.
2. **The UUID is passed as a parameter** into the DuckDB query. DuckDB sees `WHERE user_id = $1` with a plain UUID value it can handle natively.
3. **`SECURITY DEFINER` provides the necessary privileges.** The function runs as `postgres` (superuser), which has DuckDB execution rights and access to the private schema.
4. **The JWT context survives `SECURITY DEFINER`.** `SECURITY DEFINER` changes the *role* but not *session-level GUC values*. The `request.jwt.claims` GUC (set by PostgREST) is still readable, so `auth.uid()` still resolves correctly.
5. **The private schema is invisible to the caller.** Even though the function accesses `private.transactions`, the `authenticated` role has no direct access to the `private` schema. The only way to reach the data is through the function.

### Why this is the same as the FDW pattern

Supabase's [Foreign Data Wrapper documentation](https://supabase.com/docs/guides/database/extensions/wrappers/overview#security) recommends the same pattern for the same fundamental reason: the external data source (whether it's a foreign server or DuckDB's embedded engine) cannot evaluate PostgreSQL security constructs. The solution in both cases is:

- Keep the external-backed table in a **private schema** (not exposed via the API)
- Create **`SECURITY DEFINER` functions** in the `public` schema that:
  1. Evaluate `auth.uid()` in PostgreSQL
  2. Pass the result as a plain parameter to the query
  3. Return only the filtered rows

---

## Other Ideas and Why They Don't Work (Yet)

### Idea: pg_duckdb could learn to delegate PostgreSQL functions

If pg_duckdb's query planner could recognize PostgreSQL functions it doesn't know about and delegate them back to Postgres (similar to how some FDW implementations handle remote vs. local evaluation), then `auth.uid()` could work in view WHERE clauses and potentially in RLS policies. This would require changes to pg_duckdb's query planning internals.

### Idea: Middleware/proxy-based row filtering

A PostgREST middleware or Postgres extension could intercept queries to DuckLake tables and automatically inject `WHERE user_id = auth.uid()` as a pre-evaluated parameter (similar to what our SECURITY DEFINER functions do, but transparently). This doesn't exist today.

### Idea: DuckDB-native row filtering

DuckDB has its own access control features in development. If DuckLake could accept a "row filter" parameter at the catalog level (e.g., "always filter by this column = this session variable"), it could enforce row-level security within DuckDB itself. This would require DuckLake-specific development.

### Idea: Postgres rules or triggers for transparent filtering

Postgres `RULES` (`CREATE RULE`) can rewrite queries transparently, but they operate at the query rewrite stage — before DuckDB takes over execution. A rule that rewrites `SELECT * FROM transactions` to `SELECT * FROM transactions WHERE user_id = auth.uid()` would still fail because DuckDB would see `auth.uid()` in the rewritten query.

### Bottom line

The SECURITY DEFINER function pattern is currently the **only working approach** because it's the only one that evaluates PostgreSQL functions *before* the query reaches DuckDB. Any approach that embeds `auth.uid()` into a query plan that DuckDB will execute will fail.

---

## Obstacles Along the Way

### Identity Columns Not Supported

```sql
CREATE TABLE transactions (
  id BIGINT GENERATED ALWAYS AS IDENTITY,  -- fails
  ...
) USING ducklake;
-- ERROR: Identity columns are not supported in DuckDB
```

DuckDB does not support `GENERATED ALWAYS AS IDENTITY`. For DuckLake tables, omit identity/serial columns or manage IDs in application code.

### DuckDB Execution Blocked Inside Functions

```sql
-- ERROR: DuckDB execution is not supported inside functions
```

By default, `duckdb.unsafe_allow_execution_inside_functions = off`. PostgreSQL wraps PL/pgSQL function calls in implicit subtransactions (savepoints) — this is how Postgres handles `EXCEPTION` blocks. DuckDB doesn't support savepoints, so coordinating transaction state between the two engines inside a function can crash in edge cases. The pg_duckdb team [disabled this by default in v1.0.0](https://github.com/duckdb/pg_duckdb/releases/tag/v1.0.0) as a stability guard, with plans to fix the underlying subtransaction handling and re-enable it in a future release.

The `unsafe_` prefix signals "this works but may crash in rare cases" — not a security risk. For our SECURITY DEFINER functions it's safe because they're simple (declare a variable, run one query, return) with no `EXCEPTION` blocks that would trigger subtransactions. The `SET` is scoped to the function only:

```sql
CREATE FUNCTION ...
SET duckdb.unsafe_allow_execution_inside_functions = 'on'
AS $$ ... $$;
```

### DuckLake Catalog Permissions

```sql
-- ERROR: permission denied for table ducklake_table
```

pg_duckdb checks the internal `ducklake` schema (where DuckLake stores its catalog metadata) when intercepting DDL — even on non-DuckDB tables. Non-superuser roles need direct access grants:

```sql
-- Must grant directly because NOINHERIT roles don't inherit group privileges
GRANT USAGE ON SCHEMA ducklake TO supabase_auth_admin, supabase_storage_admin, authenticated;
GRANT SELECT ON ALL TABLES IN SCHEMA ducklake TO supabase_auth_admin, supabase_storage_admin, authenticated;
```

### duckdb.postgres_role and NOINHERIT Roles

The `duckdb.postgres_role` GUC controls which PostgreSQL roles are allowed to execute DuckDB queries. It has `postmaster` context (requires a full PostgreSQL restart) and **only accepts a single role name**.

If multiple roles need DuckDB access, create a **group role**:

```sql
CREATE ROLE duckdb_users NOLOGIN;

-- CRITICAL: Use WITH INHERIT TRUE for NOINHERIT roles (like supabase_auth_admin).
-- Without it, NOINHERIT roles don't inherit the group's privileges and pg_duckdb's
-- role membership check will fail.
GRANT duckdb_users TO authenticated WITH INHERIT TRUE;
GRANT duckdb_users TO supabase_auth_admin WITH INHERIT TRUE;
GRANT duckdb_users TO supabase_storage_admin WITH INHERIT TRUE;

ALTER SYSTEM SET duckdb.postgres_role = 'duckdb_users';
```

**Important:** `duckdb.postgres_role` is a postmaster-context GUC. `ALTER SYSTEM SET` writes to `postgresql.auto.conf` but doesn't take effect until the next restart. On the first boot (during initdb), the GUC is empty. You must also set it via the Docker command line:

```yaml
# docker-compose.yml
pgducklake:
  command: ["postgres", "-c", "duckdb.postgres_role=duckdb_users"]
```

### pg_duckdb Intercepts ALL DDL (Not Just DuckLake Tables)

pg_duckdb intercepts `ALTER TABLE`, `DROP TABLE IF EXISTS`, and other DDL commands across **all schemas** — even for regular PostgreSQL heap tables. This causes problems for services like GoTrue (Supabase Auth) that run their own migrations:

```
-- GoTrue migration tries:
DROP TABLE IF EXISTS auth.sso_sessions;
-- ERROR: DuckDB execution is not allowed because you have not been granted the duckdb.postgres_role
```

This is why the `duckdb_users` group role must include `supabase_auth_admin` and `supabase_storage_admin`.

### auth.uid() and Non-Legacy PostgREST GUCs

With `PGRST_DB_USE_LEGACY_GUCS=false` (recommended for PostgREST v13+), PostgREST stores the JWT as a single JSON GUC `request.jwt.claims` instead of individual `request.jwt.claim.sub`, `request.jwt.claim.role`, etc.

GoTrue's migrations create `auth.uid()` using the **legacy** format (`current_setting('request.jwt.claim.sub')`), which returns empty with non-legacy GUCs. Our init script (`scripts/init-supabase-roles.sql`) creates `auth.uid()` to handle both formats:

```sql
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid AS $$
  SELECT coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid;
$$ LANGUAGE sql STABLE;
```

### DuckDB Cannot Convert NUMERIC Parameters

When passing parameters to DuckDB via PL/pgSQL functions, DuckDB cannot convert Postgres `NUMERIC` (OID 1700) parameters:

```
ERROR: Could not convert Postgres parameter of type: 1700 to DuckDB type
```

Use `DOUBLE PRECISION` for function parameters and cast inside the function body:

```sql
CREATE FUNCTION insert_transaction(p_amount DOUBLE PRECISION, ...)
AS $$
BEGIN
  INSERT INTO private.transactions (amount, ...)
  VALUES (p_amount::NUMERIC(10,2), ...);
END;
$$;
```

### GoTrue Migration Idempotency

GoTrue's migrations use `ADD CONSTRAINT` without `IF NOT EXISTS` (which PostgreSQL doesn't support for most constraint types). If a migration partially succeeds (constraint created) but the transaction doesn't commit cleanly, retries fail with "constraint already exists" and GoTrue enters a crash loop. The fix is a clean `docker compose down -v` to wipe volumes and start fresh.

---

## File Structure

| File | Purpose | When it runs |
|------|---------|--------------|
| `scripts/init-supabase-roles.sql` | Supabase roles, `auth.uid()`, schema grants | initdb (boot) |
| `scripts/init-pgducklake-s3.sql` | DuckDB S3 config, `duckdb_users` role | initdb (boot) |
| `scripts/init-ducklake-demo.sql` | Private schema, DuckLake table, SECURITY DEFINER functions | initdb (boot) |
| `scripts/seed-demo-data.ts` | Test users (Alice, Bob) via Supabase Auth + sample transactions | After boot (`bun`) |
| `scripts/test-rls-ducklake.sql` | Verification queries + automated pass/fail | After seed (Studio) |
| `scripts/test-rls-supabase-js.ts` | End-to-end test via Supabase JS client | After boot (CLI) |

---

## Working Solution: Complete Setup

### Init scripts (automatic on `docker compose up`)

The Dockerfile copies three init scripts into `/docker-entrypoint-initdb.d/`:

1. **`init-supabase-roles.sql`** — creates Supabase roles, `auth.uid()` (with non-legacy GUC support), schema grants
2. **`init-pgducklake-s3.sql`** — configures DuckDB S3, creates `duckdb_users` group role, grants ducklake catalog access
3. **`init-ducklake-demo.sql`** — creates the private schema, DuckLake `transactions` table, and three SECURITY DEFINER functions:
   - `get_my_transactions()` — returns the calling user's transactions
   - `get_my_transaction_summary()` — returns count and sum for the calling user
   - `insert_transaction()` — inserts a transaction (service_role only)

### Seed demo data (run once after boot)

```
bun scripts/seed-demo-data.ts
```

Creates two test users via the Supabase Auth API and inserts sample transactions:

1. **Alice** (`alice@test.local` / `password123`) — 3 transactions
2. **Bob** (`bob@test.local` / `password123`) — 2 transactions

The seed script is idempotent — if users already exist it signs in instead of signing up.

### SECURITY DEFINER functions

```sql
-- Returns the calling user's transactions
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

-- Lock down permissions
REVOKE EXECUTE ON FUNCTION public.get_my_transactions() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_my_transactions() FROM anon;
GRANT EXECUTE ON FUNCTION public.get_my_transactions() TO authenticated;
```

### Client Usage

```typescript
import { createClient } from '@supabase/supabase-js'

const supabase = createClient('http://localhost:8000', '<ANON_KEY>')

// Sign in (Alice was created by seed-demo-data.sql)
await supabase.auth.signInWithPassword({
  email: 'alice@test.local',
  password: 'password123'
})

// Call the SECURITY DEFINER function via PostgREST .rpc()
// Only returns the authenticated user's transactions
const { data, error } = await supabase.rpc('get_my_transactions')

// Aggregate query — also filtered to current user
const { data: summary } = await supabase.rpc('get_my_transaction_summary')
```

---

## Test Scripts

### SQL test (Supabase Studio)

Run `scripts/test-rls-ducklake.sql` from the Studio SQL Editor. It includes:

- Individual query blocks you can run one at a time to see results
- An automated DO block at the end that outputs pass/fail via `RAISE NOTICE`

```
[PASS] Superuser sees all 5 rows
[PASS] Superuser total sum = 214.50
[PASS] Alice sees 3 transactions
[PASS] Alice sum = 64.50
[PASS] Bob sees 2 transactions
[PASS] Bob sum = 150.00
[PASS] Authenticated denied direct access to private.transactions
[PASS] Anon denied execution of get_my_transaction_summary()

=== Results: 8 passed, 0 failed ===
```

### Supabase JS end-to-end test (real auth flow)

```
bun scripts/test-rls-supabase-js.ts
```

Signs up two users via GoTrue, inserts data via service_role, then queries as each user:

```
[PASS] Alice rpc('get_my_transactions') succeeds
[PASS] Alice sees 3 transactions
[PASS] Alice sees only her descriptions
[PASS] Bob rpc('get_my_transactions') succeeds
[PASS] Bob sees 2 transactions
[PASS] Alice rpc('get_my_transaction_summary') succeeds
[PASS] Alice transaction_count = 3
[PASS] Alice total_amount = 64.50
[PASS] Bob rpc('get_my_transaction_summary') succeeds
[PASS] Bob transaction_count = 2
[PASS] Bob total_amount = 150.00
[PASS] Anon rpc('get_my_transactions') is denied
[PASS] Alice cannot see any of Bob's transactions
```

---

## Better DX: Views Over SECURITY DEFINER Functions

The `.rpc()` calling convention works but loses the "normal table" feel — you can't use PostgREST's query syntax (filtering, ordering, pagination via query params). A simple fix: **wrap the SECURITY DEFINER function in a view**.

```sql
CREATE VIEW public.yellow_trips_summary AS
  SELECT * FROM get_my_trip_summary_ducklake();

GRANT SELECT ON public.yellow_trips_summary TO authenticated;
```

This **still enforces RLS correctly** because:

1. The view's definition references a **PL/pgSQL function**, not a DuckLake table directly
2. When a client queries the view, PostgreSQL expands it to the function call and **Postgres executes the function** — not DuckDB
3. Inside the function, `auth.uid()` is evaluated in PL/pgSQL as normal, then the DuckDB query runs with the plain UUID parameter
4. pg_duckdb has no reason to intercept the view query because it doesn't reference any DuckLake table — it references a function that *returns a table type*, which is a regular Postgres result set

The DX improvement is significant — clients get the familiar table-like interface:

```typescript
// Instead of:
const { data } = await supabase.rpc('get_my_trip_summary_ducklake')

// You get the normal table-like API with full PostgREST query syntax:
const { data } = await supabase
  .from('yellow_trips_summary')
  .select('*')
  .gte('total_amount', 100)
  .order('trip_count', { ascending: false })
  .limit(10)
```

This gives the illusion of querying a normal table while the function underneath still enforces row-level filtering. The view owner must have execute permission on the function, and `auth.uid()` continues to work because the session-level GUCs (set by PostgREST) are unaffected by the view's execution context.

---

## TODO

- [ ] Test INSERT/UPDATE/DELETE via SECURITY DEFINER functions (not just SELECT)
- [ ] Benchmark: compare query latency of SECURITY DEFINER function wrapper vs direct table access
- [ ] Investigate pg_duckdb function delegation (could it learn to call back into Postgres for unknown functions?)
- [ ] Prototype the view-over-function pattern and verify PostgREST query params (filtering, ordering, pagination) work end-to-end

---

## Idea: pg_duckdb Could Delegate RLS Evaluation Back to Postgres

This is technically feasible but non-trivial. Here's how RLS works under the hood:

### How Postgres RLS works internally

- Policies are stored in `pg_policy` catalog (per-table, per-command)
- Each policy has a `USING` expression (a boolean expression like `user_id = auth.uid()`)
- The Postgres executor **appends** these expressions as implicit WHERE clauses to every query on the table
- The expressions can reference **any Postgres function** and **table columns**

### What DuckDB would need to do

The expression `user_id = auth.uid()` has two parts:
- `user_id` — a column reference (DuckDB understands this)
- `auth.uid()` — a Postgres function call (DuckDB does not)

The most feasible approach would be for pg_duckdb to:

1. Detect that a table has RLS enabled (read `pg_class.relrowsecurity`)
2. Read the policy expressions from `pg_policy`
3. **Pre-evaluate** any Postgres function calls (like `auth.uid()`) by executing them in Postgres — exactly what our SECURITY DEFINER functions do manually
4. Rewrite the policy expression with resolved values: `user_id = auth.uid()` becomes `user_id = '550e8400-...'`
5. Inject that as a DuckDB WHERE filter

This is essentially **automating the SECURITY DEFINER pattern** inside pg_duckdb's query planner. The pg_duckdb extension already has a query planning hook where it intercepts queries — it could, at that stage, resolve RLS policies and inject the filters.

### Why it's hard but not impossible

- Policy expressions can be complex (subqueries, joins, multiple function calls) — not just simple `column = function()` comparisons
- pg_duckdb would need to classify each sub-expression as "can evaluate in Postgres" vs "must push to DuckDB" and split accordingly
- The current pg_duckdb architecture takes an all-or-nothing approach to query execution — it either handles the whole query or hands it back to Postgres entirely
- But the postgres_scanner infrastructure is already there (DuckLake uses it for metadata), so calling back into Postgres for scalar function evaluation is plausible

**The simpler version** — handling the common case of `column = auth.uid()` policies — would cover 90% of real-world Supabase RLS patterns and would be much easier to implement than the general case. That would be a great feature request for the pg_duckdb team.
