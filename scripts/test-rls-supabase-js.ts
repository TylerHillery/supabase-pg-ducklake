/**
 * End-to-end RLS test for DuckLake TAM tables via Supabase JS client.
 *
 * Prerequisites:
 *   1. docker compose up -d  (all services healthy)
 *   2. bun scripts/seed-demo-data.ts  (creates test users + transactions)
 *
 * Run:
 *   bun scripts/test-rls-supabase-js.ts
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL ?? "http://localhost:8000";
const ANON_KEY =
  process.env.SUPABASE_ANON_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyAgCiAgICAicm9sZSI6ICJhbm9uIiwKICAgICJpc3MiOiAic3VwYWJhc2UtZGVtbyIsCiAgICAiaWF0IjogMTY0MTc2OTIwMCwKICAgICJleHAiOiAxNzk5NTM1NjAwCn0.dc_X5iR_VP_qT0zsiyj_I_OZ2T9FtRU2BBNWN8Bu4GE";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string) {
  if (condition) {
    console.log(`  [PASS] ${label}`);
    passed++;
  } else {
    console.log(`  [FAIL] ${label}`);
    failed++;
  }
}

async function signIn(
  email: string,
  password: string,
): Promise<{ userId: string; accessToken: string }> {
  const client = createClient(SUPABASE_URL, ANON_KEY);
  const { data, error } = await client.auth.signInWithPassword({
    email,
    password,
  });
  if (error) throw new Error(`signIn(${email}): ${error.message}`);
  return {
    userId: data.user.id,
    accessToken: data.session.access_token,
  };
}

function authedClient(accessToken: string): SupabaseClient {
  return createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function main() {
  console.log("=== Supabase JS + DuckLake RLS End-to-End Test ===\n");

  // 1. Sign in as seeded test users
  console.log("Signing in test users...\n");

  const alice = await signIn("alice@test.local", "password123");
  console.log(`  Alice: ${alice.userId}`);

  const bob = await signIn("bob@test.local", "password123");
  console.log(`  Bob:   ${bob.userId}`);

  // 2. Query as Alice
  console.log("\n--- Test 1: Alice's transactions ---");
  {
    const client = authedClient(alice.accessToken);
    const { data, error } = await client.rpc("get_my_transactions");
    assert(!error, `Alice rpc('get_my_transactions') succeeds`);
    assert(
      data?.length === 3,
      `Alice sees 3 transactions (got ${data?.length})`,
    );

    const descriptions = data?.map((r: any) => r.description).sort();
    assert(
      JSON.stringify(descriptions) ===
        JSON.stringify(["Coffee", "Groceries", "Salary"]),
      `Alice sees only her descriptions`,
    );
  }

  // 3. Query as Bob
  console.log("\n--- Test 2: Bob's transactions ---");
  {
    const client = authedClient(bob.accessToken);
    const { data, error } = await client.rpc("get_my_transactions");
    assert(!error, `Bob rpc('get_my_transactions') succeeds`);
    assert(data?.length === 2, `Bob sees 2 transactions (got ${data?.length})`);
  }

  // 4. Summary as Alice
  console.log("\n--- Test 3: Alice's summary ---");
  {
    const client = authedClient(alice.accessToken);
    const { data, error } = await client.rpc("get_my_transaction_summary");
    assert(!error, `Alice rpc('get_my_transaction_summary') succeeds`);
    const row = data?.[0];
    assert(
      row?.transaction_count === 3,
      `Alice transaction_count = 3 (got ${row?.transaction_count})`,
    );
    assert(
      parseFloat(row?.total_amount) === 64.5,
      `Alice total_amount = 64.50 (got ${row?.total_amount})`,
    );
  }

  // 5. Summary as Bob
  console.log("\n--- Test 4: Bob's summary ---");
  {
    const client = authedClient(bob.accessToken);
    const { data, error } = await client.rpc("get_my_transaction_summary");
    assert(!error, `Bob rpc('get_my_transaction_summary') succeeds`);
    const row = data?.[0];
    assert(
      row?.transaction_count === 2,
      `Bob transaction_count = 2 (got ${row?.transaction_count})`,
    );
    assert(
      parseFloat(row?.total_amount) === 150.0,
      `Bob total_amount = 150.00 (got ${row?.total_amount})`,
    );
  }

  // 6. Anon cannot call the functions
  console.log("\n--- Test 5: Anon access denied ---");
  {
    const client = createClient(SUPABASE_URL, ANON_KEY);
    const { error } = await client.rpc("get_my_transactions");
    assert(
      !!error,
      `Anon rpc('get_my_transactions') is denied (${error?.message ?? "no error!"})`,
    );
  }

  // 7. Alice cannot see Bob's data
  console.log("\n--- Test 6: Cross-user isolation ---");
  {
    const client = authedClient(alice.accessToken);
    const { data } = await client.rpc("get_my_transactions");
    const hasBobData = data?.some((r: any) => r.user_id === bob.userId);
    assert(!hasBobData, `Alice cannot see any of Bob's transactions`);
  }

  // Results
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("\nFATAL:", err.message);
  process.exit(1);
});
