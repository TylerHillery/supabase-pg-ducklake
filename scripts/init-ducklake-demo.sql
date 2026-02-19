-- =============================================================================
-- DuckLake Demo: Private schema, tables, and SECURITY DEFINER functions
-- =============================================================================
-- Runs during initdb (before GoTrue). Sets up all infrastructure for the
-- RLS-on-DuckLake-TAM demo using the FDW pattern:
--   - DuckLake tables in a private schema (not exposed via PostgREST API)
--   - SECURITY DEFINER functions that evaluate auth.uid() in PL/pgSQL,
--     then pass the UUID as a plain parameter to DuckDB
-- =============================================================================

-- =============================================================================
-- 1. Private schema (invisible to PostgREST API roles)
-- =============================================================================

CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM anon, authenticated, service_role;

-- =============================================================================
-- 2. DuckLake transactions table
-- =============================================================================

SET search_path TO private, public;

CREATE TABLE private.transactions (
  user_id UUID NOT NULL,
  amount NUMERIC(10,2) NOT NULL,
  description TEXT
) USING ducklake;

RESET search_path;

-- =============================================================================
-- 3. SECURITY DEFINER functions (the FDW pattern)
-- =============================================================================

-- get_my_transactions(): returns all transactions for the authenticated user
CREATE OR REPLACE FUNCTION public.get_my_transactions()
RETURNS TABLE (
  user_id UUID,
  amount NUMERIC(10,2),
  description TEXT
)
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

-- get_my_transaction_summary(): returns count and sum for the authenticated user
CREATE OR REPLACE FUNCTION public.get_my_transaction_summary()
RETURNS TABLE (
  transaction_count BIGINT,
  total_amount NUMERIC
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
SET duckdb.unsafe_allow_execution_inside_functions = 'on'
AS $$
DECLARE
  uid UUID := auth.uid();
BEGIN
  RETURN QUERY
  SELECT count(*)::BIGINT, sum(t.amount)
  FROM private.transactions t
  WHERE t.user_id = uid;
END;
$$;

-- insert_transaction(): inserts a transaction (service_role only)
-- Uses DOUBLE PRECISION parameter because DuckDB can't convert Postgres NUMERIC (OID 1700).
CREATE OR REPLACE FUNCTION public.insert_transaction(
  p_user_id UUID,
  p_amount DOUBLE PRECISION,
  p_description TEXT
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
SET duckdb.unsafe_allow_execution_inside_functions = 'on'
AS $$
BEGIN
  INSERT INTO private.transactions (user_id, amount, description)
  VALUES (p_user_id, p_amount::NUMERIC(10,2), p_description);
END;
$$;

-- =============================================================================
-- 4. Grants
-- =============================================================================

-- get_my_transactions: authenticated only
REVOKE EXECUTE ON FUNCTION public.get_my_transactions() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_my_transactions() FROM anon;
GRANT EXECUTE ON FUNCTION public.get_my_transactions() TO authenticated;

-- get_my_transaction_summary: authenticated only
REVOKE EXECUTE ON FUNCTION public.get_my_transaction_summary() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_my_transaction_summary() FROM anon;
GRANT EXECUTE ON FUNCTION public.get_my_transaction_summary() TO authenticated;

-- insert_transaction: service_role only (not authenticated users)
REVOKE EXECUTE ON FUNCTION public.insert_transaction(UUID, DOUBLE PRECISION, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.insert_transaction(UUID, DOUBLE PRECISION, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION public.insert_transaction(UUID, DOUBLE PRECISION, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.insert_transaction(UUID, DOUBLE PRECISION, TEXT) TO service_role;
