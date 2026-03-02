/**
 * Seed demo data: creates test users via Supabase Auth, inserts transactions,
 * and creates yellow taxi trip tables (heap + ducklake) with user_ids baked in.
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

const PG_URL =
  process.env.PG_URL ??
  "postgresql://postgres:your-super-secret-and-long-postgres-password@localhost:5433/postgres";

async function psql(query: string): Promise<string> {
  const proc = Bun.spawn(["psql", PG_URL, "-c", query], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  if (exitCode !== 0) throw new Error(`psql: ${stderr.trim()}`);
  return stdout.trim();
}

async function signUpOrSignIn(
  email: string,
  password: string,
): Promise<string> {
  const { data, error } = await anon.auth.signUp({ email, password });
  if (!error && data.user) return data.user.id;

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

async function insertOrder(
  userId: string,
  productName: string,
  quantity: number,
  unitPrice: number,
  status: string,
) {
  // Use psql directly — PostgREST schema cache won't know about tables created
  // in the same seed run until it reloads, so bypass it entirely.
  await psql(
    `INSERT INTO public.orders (user_id, product_name, quantity, unit_price, status)` +
    ` VALUES ('${userId}', '${productName.replace(/'/g, "''")}', ${quantity}, ${unitPrice}, '${status}');`,
  );
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

  // 3. Create orders table (heap) with RLS + CDC publication
  console.log("\nSetting up orders table (heap + RLS + CDC publication)...");

  // 3a. Table DDL + replica identity (standard Postgres DDL — no DuckDB involvement)
  await psql(`
    CREATE TABLE IF NOT EXISTS public.orders (
      id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_id     UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
      product_name TEXT       NOT NULL,
      quantity    INT         NOT NULL DEFAULT 1,
      unit_price  INTEGER       NOT NULL,
      status      TEXT        NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'processing', 'shipped', 'delivered', 'cancelled')),
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    -- Full replica identity so CDC tools receive complete before/after row images
    ALTER TABLE public.orders REPLICA IDENTITY FULL;
    ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.orders FORCE ROW LEVEL SECURITY;
  `);

  await psql(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'orders'
          AND policyname = 'Users can view own orders'
      ) THEN
        CREATE POLICY "Users can view own orders"
          ON public.orders FOR SELECT
          USING (user_id = auth.uid());
      END IF;
    END $$;
    GRANT SELECT ON public.orders TO authenticated;
  `);

  // 3b. Logical replication publication for CDC
  await psql(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'orders_cdc') THEN
        CREATE PUBLICATION orders_cdc
          FOR TABLE public.orders
          WITH (publish = 'insert, update, delete');
      END IF;
    END $$;
  `);
  console.log("  Created publication: orders_cdc (insert, update, delete)");

  // // 3c. DuckLake target table — CDC tool writes replicated rows here
  // console.log("  Creating private.orders_ducklake (CDC landing table)...");
  // await psql(`
  //   SET search_path TO private, public;
  //   CREATE TABLE IF NOT EXISTS private.orders_ducklake (
  //     id           BIGINT,
  //     user_id      UUID,
  //     product_name TEXT,
  //     quantity     INT,
  //     unit_price   DOUBLE PRECISION,
  //     status       TEXT,
  //     created_at   TIMESTAMPTZ,
  //     updated_at   TIMESTAMPTZ
  //   ) USING ducklake;
  // `);
  // console.log("    done");

  // 4. Seed orders
  console.log("\nInserting orders...");

  await insertOrder(aliceId, "Mechanical Keyboard",  1,  14999, "delivered");
  await insertOrder(aliceId, "USB-C Hub",             2,   2999, "shipped");
  await insertOrder(aliceId, "Monitor Stand",         1,   4999, "processing");
  await insertOrder(aliceId, "Webcam 4K",             1,   8999, "pending");
  await insertOrder(aliceId, "Desk Mat XL",           1,   2499, "delivered");
  console.log("  5 orders for Alice");

  await insertOrder(bobId, "Noise-Cancelling Headphones", 1, 19999, "delivered");
  await insertOrder(bobId, "Laptop Stand",                1,  3999, "shipped");
  await insertOrder(bobId, "Wireless Mouse",              2,  3499, "pending");
  console.log("  3 orders for Bob");

  // // 5. Create yellow taxi trip tables with user_ids baked in
  // //    vendor_id=1 → Alice, vendor_id=2 → Bob
  // console.log("\nCreating yellow taxi trip tables (~15M rows each)...");

  // // 5a. Heap table (regular Postgres — will use standard RLS)
  // console.log("  Creating public.yellow_trips_heap...");
  // await psql(`
  //   SET duckdb.force_execution = true;
  //   CREATE TABLE public.yellow_trips_heap AS
  //   SELECT
  //     r['VendorID']::INT              AS vendor_id,
  //     r['tpep_pickup_datetime']       AS pickup_at,
  //     r['tpep_dropoff_datetime']      AS dropoff_at,
  //     r['passenger_count']::INT       AS passenger_count,
  //     r['trip_distance']              AS trip_distance,
  //     r['PULocationID']::INT          AS pu_location_id,
  //     r['DOLocationID']::INT          AS do_location_id,
  //     r['payment_type']::INT          AS payment_type,
  //     r['fare_amount']                AS fare_amount,
  //     r['tip_amount']                 AS tip_amount,
  //     r['tolls_amount']               AS tolls_amount,
  //     r['total_amount']               AS total_amount,
  //     CASE WHEN r['VendorID'] = 1
  //       THEN '${aliceId}'::UUID
  //       ELSE '${bobId}'::UUID
  //     END                             AS user_id
  //   FROM read_parquet('/data/yellow_tripdata_2023-01.parquet') r;
  // `);

  // await psql(`
  //   CREATE INDEX idx_yellow_trips_heap_user_id ON public.yellow_trips_heap (user_id);
  //   ALTER TABLE public.yellow_trips_heap ENABLE ROW LEVEL SECURITY;
  //   ALTER TABLE public.yellow_trips_heap FORCE ROW LEVEL SECURITY;
  //   CREATE POLICY "Users can view own trips"
  //     ON public.yellow_trips_heap FOR SELECT
  //     USING (user_id = auth.uid());
  //   GRANT SELECT ON public.yellow_trips_heap TO authenticated;
  // `);
  // console.log("    done (with RLS policy)");

  // // 5b. DuckLake table (uses SECURITY DEFINER function — no native RLS)
  // console.log("  Creating private.yellow_trips_ducklake...");
  // await psql(`
  //   SET search_path TO private, public;
  //   SET duckdb.force_execution = true;
  //   CREATE TABLE private.yellow_trips_ducklake USING ducklake AS
  //   SELECT
  //     r['VendorID']::INT              AS vendor_id,
  //     r['tpep_pickup_datetime']       AS pickup_at,
  //     r['tpep_dropoff_datetime']      AS dropoff_at,
  //     r['passenger_count']::INT       AS passenger_count,
  //     r['trip_distance']              AS trip_distance,
  //     r['PULocationID']::INT          AS pu_location_id,
  //     r['DOLocationID']::INT          AS do_location_id,
  //     r['payment_type']::INT          AS payment_type,
  //     r['fare_amount']                AS fare_amount,
  //     r['tip_amount']                 AS tip_amount,
  //     r['tolls_amount']               AS tolls_amount,
  //     r['total_amount']               AS total_amount,
  //     CASE WHEN r['VendorID'] = 1
  //       THEN '${aliceId}'::UUID
  //       ELSE '${bobId}'::UUID
  //     END                             AS user_id
  //   FROM read_parquet('/data/yellow_tripdata_2023-01.parquet') r;
  // `);
  // console.log("    done (uses get_my_trip_summary_ducklake() for access)");

  console.log("\nDone! You can now:");
  console.log("  - Run tests:  bun scripts/test-rls-supabase-js.ts");
  console.log("  - Sign in as: alice@test.local / password123");
  console.log("  - Sign in as: bob@test.local   / password123");
  console.log("\nCDC (orders → DuckLake):");
  console.log("  Publication: orders_cdc  (logical replication, insert/update/delete)");
  console.log("  Source:      public.orders          (heap, REPLICA IDENTITY FULL)");
  console.log("  Target:      private.orders_ducklake (DuckLake TAM)");
  console.log("\nPerformance comparison:");
  console.log("  Heap + RLS:     SELECT count(*), sum(fare_amount), sum(tip_amount), avg(trip_distance) FROM yellow_trips_heap;");
  console.log("  DuckLake + RPC: SELECT * FROM get_my_trip_summary_ducklake();");

}

main().catch((err) => {
  console.error("\nFATAL:", err.message);
  process.exit(1);
});
