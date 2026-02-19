/**
 * Seed demo data: creates test users via Supabase Auth and inserts transactions.
 *
 * Prerequisites:
 *   docker compose up -d  (all services healthy)
 *
 * Run:
 *   bun scripts/seed-demo-data.ts
 */

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL ?? "http://localhost:8000";
const ANON_KEY =
  process.env.SUPABASE_ANON_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyAgCiAgICAicm9sZSI6ICJhbm9uIiwKICAgICJpc3MiOiAic3VwYWJhc2UtZGVtbyIsCiAgICAiaWF0IjogMTY0MTc2OTIwMCwKICAgICJleHAiOiAxNzk5NTM1NjAwCn0.dc_X5iR_VP_qT0zsiyj_I_OZ2T9FtRU2BBNWN8Bu4GE";
const SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyAgCiAgICAicm9sZSI6ICJzZXJ2aWNlX3JvbGUiLAogICAgImlzcyI6ICJzdXBhYmFzZS1kZW1vIiwKICAgICJpYXQiOiAxNjQxNzY5MjAwLAogICAgImV4cCI6IDE3OTk1MzU2MDAKfQ.DaYlNEoUrrEn2Ig7tqibS-PHK5vgusbcbo7X36XVt4Q";

const anon = createClient(SUPABASE_URL, ANON_KEY);
const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

async function signUpOrSignIn(
  email: string,
  password: string,
): Promise<string> {
  // Try sign up first
  const { data, error } = await anon.auth.signUp({ email, password });
  if (!error && data.user) return data.user.id;

  // If user already exists, sign in to get their ID
  if (error?.message?.includes("already registered")) {
    const { data: signIn, error: signInErr } =
      await anon.auth.signInWithPassword({ email, password });
    if (signInErr) throw new Error(`signIn(${email}): ${signInErr.message}`);
    return signIn.user.id;
  }

  throw new Error(`signUp(${email}): ${error?.message}`);
}

async function insertTransaction(
  userId: string,
  amount: number,
  description: string,
) {
  const { error } = await admin.rpc("insert_transaction", {
    p_user_id: userId,
    p_amount: amount,
    p_description: description,
  });
  if (error)
    throw new Error(`insert_transaction(${description}): ${error.message}`);
}

async function main() {
  console.log("=== Seeding Demo Data ===\n");

  // 1. Create test users via Supabase Auth
  console.log("Creating test users...");
  const aliceId = await signUpOrSignIn("alice@test.local", "password123");
  console.log(`  Alice: ${aliceId}`);

  const bobId = await signUpOrSignIn("bob@test.local", "password123");
  console.log(`  Bob:   ${bobId}`);

  // 2. Insert transactions via service_role RPC
  console.log("\nInserting transactions...");

  await insertTransaction(aliceId, 100.0, "Salary");
  await insertTransaction(aliceId, -25.5, "Groceries");
  await insertTransaction(aliceId, -10.0, "Coffee");
  console.log("  3 transactions for Alice");

  await insertTransaction(bobId, 200.0, "Salary");
  await insertTransaction(bobId, -50.0, "Rent");
  console.log("  2 transactions for Bob");

  console.log("\nDone! You can now:");
  console.log("  - Run tests:  bun scripts/test-rls-supabase-js.ts");
  console.log("  - Sign in as: alice@test.local / password123");
  console.log("  - Sign in as: bob@test.local   / password123");
}

main().catch((err) => {
  console.error("\nFATAL:", err.message);
  process.exit(1);
});
