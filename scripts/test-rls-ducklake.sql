-- =============================================================================
-- Test: RLS on DuckLake TAM Tables
-- =============================================================================
-- Run from Supabase Studio SQL Editor (or any SQL client).
-- No psql metacommands — plain SQL only.
--
-- Prerequisites:
--   1. docker compose up -d  (all services healthy)
--   2. Run seed-demo-data.sql (creates test users + transactions)
-- =============================================================================

-- =============================================================================
-- Test 1: Superuser sees all rows
-- =============================================================================
-- Run as default Studio user (superuser). Expected: 5 rows, sum = 214.50

SELECT count(*) AS total_rows, sum(amount) AS total_sum
FROM private.transactions;

-- =============================================================================
-- Test 2: Alice sees only her transactions
-- =============================================================================
-- Simulates PostgREST setting the JWT context for Alice.
-- set_config(..., true) is equivalent to SET LOCAL (transaction-scoped).

BEGIN;
  SET LOCAL ROLE authenticated;
  SELECT set_config('request.jwt.claim.sub',
    (SELECT id::text FROM auth.users WHERE email = 'alice@test.local'),
    true
  );

  -- Expected: 3 rows (Salary, Groceries, Coffee)
  SELECT * FROM get_my_transactions();

  -- Expected: transaction_count = 3, total_amount = 64.50
  SELECT * FROM get_my_transaction_summary();
COMMIT;

-- =============================================================================
-- Test 3: Bob sees only his transactions
-- =============================================================================

BEGIN;
  SET LOCAL ROLE authenticated;
  SELECT set_config('request.jwt.claim.sub',
    (SELECT id::text FROM auth.users WHERE email = 'bob@test.local'),
    true
  );

  -- Expected: 2 rows (Salary, Rent)
  SELECT * FROM get_my_transactions();

  -- Expected: transaction_count = 2, total_amount = 150.00
  SELECT * FROM get_my_transaction_summary();
COMMIT;

-- =============================================================================
-- Test 4: Authenticated role cannot access private schema directly
-- =============================================================================
-- Expected: ERROR — permission denied for schema private

BEGIN;
  SET LOCAL ROLE authenticated;
  SELECT * FROM private.transactions;
COMMIT;

-- =============================================================================
-- Test 5: Anon cannot call SECURITY DEFINER functions
-- =============================================================================
-- Expected: ERROR — permission denied for function get_my_transactions

BEGIN;
  SET LOCAL ROLE anon;
  SELECT * FROM get_my_transactions();
COMMIT;

-- =============================================================================
-- Automated pass/fail (optional)
-- =============================================================================
-- Runs all tests in a single DO block. Results appear in the Messages tab.

DO $$
DECLARE
  row_count BIGINT;
  total_sum NUMERIC;
  alice_id UUID;
  bob_id UUID;
  pass INT := 0;
  fail INT := 0;
BEGIN
  SELECT id INTO alice_id FROM auth.users WHERE email = 'alice@test.local';
  SELECT id INTO bob_id   FROM auth.users WHERE email = 'bob@test.local';

  IF alice_id IS NULL OR bob_id IS NULL THEN
    RAISE EXCEPTION 'Test users not found. Run seed-demo-data.sql first.';
  END IF;

  -- Test 1: Superuser sees all rows
  SELECT count(*), sum(amount) INTO row_count, total_sum FROM private.transactions;
  IF row_count = 5 THEN
    RAISE NOTICE '[PASS] Superuser sees all 5 rows'; pass := pass + 1;
  ELSE
    RAISE NOTICE '[FAIL] Superuser expected 5 rows, got %', row_count; fail := fail + 1;
  END IF;
  IF total_sum = 214.50 THEN
    RAISE NOTICE '[PASS] Superuser total sum = 214.50'; pass := pass + 1;
  ELSE
    RAISE NOTICE '[FAIL] Superuser expected sum 214.50, got %', total_sum; fail := fail + 1;
  END IF;

  -- Test 2: Alice via SECURITY DEFINER functions
  PERFORM set_config('request.jwt.claim.sub', alice_id::text, true);
  SELECT transaction_count, total_amount INTO row_count, total_sum
    FROM public.get_my_transaction_summary();
  IF row_count = 3 THEN
    RAISE NOTICE '[PASS] Alice sees 3 transactions'; pass := pass + 1;
  ELSE
    RAISE NOTICE '[FAIL] Alice expected 3 transactions, got %', row_count; fail := fail + 1;
  END IF;
  IF total_sum = 64.50 THEN
    RAISE NOTICE '[PASS] Alice sum = 64.50'; pass := pass + 1;
  ELSE
    RAISE NOTICE '[FAIL] Alice expected sum 64.50, got %', total_sum; fail := fail + 1;
  END IF;

  -- Test 3: Bob via SECURITY DEFINER functions
  PERFORM set_config('request.jwt.claim.sub', bob_id::text, true);
  SELECT transaction_count, total_amount INTO row_count, total_sum
    FROM public.get_my_transaction_summary();
  IF row_count = 2 THEN
    RAISE NOTICE '[PASS] Bob sees 2 transactions'; pass := pass + 1;
  ELSE
    RAISE NOTICE '[FAIL] Bob expected 2 transactions, got %', row_count; fail := fail + 1;
  END IF;
  IF total_sum = 150.00 THEN
    RAISE NOTICE '[PASS] Bob sum = 150.00'; pass := pass + 1;
  ELSE
    RAISE NOTICE '[FAIL] Bob expected sum 150.00, got %', total_sum; fail := fail + 1;
  END IF;

  -- Test 4: Direct access denied
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM count(*) FROM private.transactions;
    RAISE NOTICE '[FAIL] Authenticated should NOT access private.transactions'; fail := fail + 1;
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE '[PASS] Authenticated denied direct access to private.transactions'; pass := pass + 1;
  END;
  RESET ROLE;

  -- Test 5: Anon denied
  BEGIN
    SET LOCAL ROLE anon;
    PERFORM * FROM public.get_my_transaction_summary();
    RAISE NOTICE '[FAIL] Anon should NOT execute get_my_transaction_summary'; fail := fail + 1;
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE '[PASS] Anon denied execution of get_my_transaction_summary()'; pass := pass + 1;
  END;
  RESET ROLE;

  RAISE NOTICE '';
  RAISE NOTICE '=== Results: % passed, % failed ===', pass, fail;
END $$;
