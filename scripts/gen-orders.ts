/**
 * Continuous order data generator for ETL/CDC testing.
 *
 * Runs in a loop: inserts new orders, advances existing order statuses,
 * and occasionally cancels + deletes orders — exercising INSERT, UPDATE,
 * and DELETE events on the orders_cdc publication.
 *
 * Prerequisites:
 *   bun scripts/seed-demo-data.ts  (users + orders table must exist)
 *
 * Run:
 *   bun scripts/gen-orders.ts
 *
 * Options (env vars):
 *   BATCH_SIZE=5        rows inserted per tick   (default: 5)
 *   TICK_MS=2000        ms between ticks         (default: 2000)
 *   MAX_TICKS=0         stop after N ticks; 0 = run forever (default: 0)
 */

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL ?? "http://localhost:8000";
const ANON_KEY =
  process.env.SUPABASE_ANON_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyAgCiAgICAicm9sZSI6ICJhbm9uIiwKICAgICJpc3MiOiAic3VwYWJhc2UtZGVtbyIsCiAgICAiaWF0IjogMTY0MTc2OTIwMCwKICAgICJleHAiOiAxNzk5NTM1NjAwCn0.dc_X5iR_VP_qT0zsiyj_I_OZ2T9FtRU2BBNWN8Bu4GE";

const PG_URL =
  process.env.PG_URL ??
  "postgresql://postgres:your-super-secret-and-long-postgres-password@localhost:5433/postgres";

const BATCH_SIZE = parseInt(process.env.BATCH_SIZE ?? "5", 10);
const TICK_MS    = parseInt(process.env.TICK_MS    ?? "2000", 10);
const MAX_TICKS  = parseInt(process.env.MAX_TICKS  ?? "0", 10);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const anon = createClient(SUPABASE_URL, ANON_KEY);

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

async function psqlQuery(query: string): Promise<string[][]> {
  const proc = Bun.spawn(["psql", PG_URL, "--csv", "--tuples-only", "-c", query], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  if (exitCode !== 0) throw new Error(`psql: ${stderr.trim()}`);
  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split(","));
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function rand(min: number, max: number): number {
  return Math.round((Math.random() * (max - min) + min) * 100) / 100;
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

const PRODUCTS: Array<{ name: string; minPrice: number; maxPrice: number }> = [
  { name: "Mechanical Keyboard",        minPrice:  7999, maxPrice: 24999 },
  { name: "USB-C Hub",                  minPrice:  1999, maxPrice:  8999 },
  { name: "Monitor Stand",              minPrice:  2999, maxPrice:  8999 },
  { name: "Webcam 4K",                  minPrice:  4999, maxPrice: 14999 },
  { name: "Desk Mat XL",                minPrice:  1499, maxPrice:  4999 },
  { name: "Noise-Cancelling Headphones",minPrice:  9999, maxPrice: 34999 },
  { name: "Laptop Stand",               minPrice:  2499, maxPrice:  6999 },
  { name: "Wireless Mouse",             minPrice:  1999, maxPrice:  7999 },
  { name: "LED Desk Lamp",              minPrice:  2999, maxPrice:  8999 },
  { name: "Cable Management Kit",       minPrice:   999, maxPrice:  2999 },
  { name: "Ergonomic Chair Cushion",    minPrice:  3999, maxPrice: 11999 },
  { name: "Portable SSD 1TB",           minPrice:  7999, maxPrice: 17999 },
  { name: "Smart Power Strip",          minPrice:  2999, maxPrice:  6999 },
  { name: "Wrist Rest Pad",             minPrice:  1299, maxPrice:  3499 },
  { name: "Blue Light Glasses",         minPrice:  1999, maxPrice:  5999 },
];

// Order lifecycle: each status can advance to the next
const NEXT_STATUS: Record<string, string | null> = {
  pending:    "processing",
  processing: "shipped",
  shipped:    "delivered",
  delivered:  null,
  cancelled:  null,
};

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

async function insertOrders(userIds: string[], count: number): Promise<number> {
  const rows = Array.from({ length: count }, () => {
    const userId  = pick(userIds);
    const product = pick(PRODUCTS);
    const qty     = Math.floor(rand(1, 5));
    const price   = Math.floor(rand(product.minPrice, product.maxPrice));
    const name    = product.name.replace(/'/g, "''");
    return `('${userId}', '${name}', ${qty}, ${price}, 'pending')`;
  });

  await psql(
    `INSERT INTO public.orders (user_id, product_name, quantity, unit_price, status) VALUES ` +
    rows.join(", ") + ";",
  );
  return count;
}

// Advance a random sample of non-terminal orders to their next status
async function advanceOrders(sampleSize: number): Promise<number> {
async function advanceOrders(sampleSize: number): Promise<number> {
  const rows = await psqlQuery(`
    SELECT id, status FROM public.orders
    WHERE status IN ('pending', 'processing', 'shipped')
    ORDER BY random()
    LIMIT ${sampleSize};
  `);

  if (rows.length === 0) return 0;

  let advanced = 0;
  for (const [id, status] of rows) {
    const next = NEXT_STATUS[status];
    if (!next) continue;
    await psql(
      `UPDATE public.orders SET status = '${next}', updated_at = NOW() WHERE id = ${id};`,
    );
    advanced++;
  }
  return advanced;
}

// Cancel a small random set of pending orders then delete them (tests DELETE CDC)
async function cancelAndDelete(maxRows: number): Promise<number> {
  const rows = await psqlQuery(`
    SELECT id FROM public.orders
    WHERE status = 'pending'
    ORDER BY random()
    LIMIT ${maxRows};
  `);

  if (rows.length === 0) return 0;

  const ids = rows.map(([id]) => id).join(", ");
  // UPDATE first so CDC consumers see the cancelled status before the DELETE
  await psql(`UPDATE public.orders SET status = 'cancelled', updated_at = NOW() WHERE id IN (${ids});`);
  await psql(`DELETE FROM public.orders WHERE id IN (${ids});`);
  return rows.length;
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

async function getUserIds(): Promise<string[]> {
  const users = ["alice@test.local", "bob@test.local"];
  const ids: string[] = [];
  for (const email of users) {
    const { data, error } = await anon.auth.signInWithPassword({
      email,
      password: "password123",
    });
    if (error) throw new Error(`signIn(${email}): ${error.message}`);
    ids.push(data.user.id);
    await anon.auth.signOut();
  }
  return ids;
}

async function main() {
  console.log("=== Order Data Generator ===");
  console.log(`  batch size : ${BATCH_SIZE} inserts/tick`);
  console.log(`  tick rate  : every ${TICK_MS}ms`);
  console.log(`  max ticks  : ${MAX_TICKS === 0 ? "unlimited (Ctrl+C to stop)" : MAX_TICKS}`);
  console.log();

  console.log("Resolving user IDs...");
  const userIds = await getUserIds();
  console.log(`  ${userIds.length} users loaded\n`);

  let tick = 0;
  let totalInserted = 0;
  let totalAdvanced = 0;
  let totalDeleted  = 0;

  while (MAX_TICKS === 0 || tick < MAX_TICKS) {
    tick++;

    const inserted = await insertOrders(userIds, BATCH_SIZE);
    totalInserted += inserted;

    // Every 3 ticks advance some orders through their lifecycle
    let advanced = 0;
    if (tick % 3 === 0) {
      advanced = await advanceOrders(Math.ceil(BATCH_SIZE * 1.5));
      totalAdvanced += advanced;
    }

    // Every 7 ticks cancel + delete a couple of pending orders
    let deleted = 0;
    if (tick % 7 === 0) {
      deleted = await cancelAndDelete(2);
      totalDeleted += deleted;
    }

    const parts = [`+${inserted} inserted`];
    if (advanced) parts.push(`~${advanced} advanced`);
    if (deleted)  parts.push(`-${deleted} deleted`);

    console.log(
      `[tick ${String(tick).padStart(4)}]  ${parts.join("  |  ")}` +
      `   (total: ${totalInserted} rows, ${totalAdvanced} advanced, ${totalDeleted} deleted)`,
    );

    if (MAX_TICKS === 0 || tick < MAX_TICKS) {
      await Bun.sleep(TICK_MS);
    }
  }

  console.log("\nDone.");
}

main().catch((err) => {
  console.error("\nFATAL:", err.message);
  process.exit(1);
});
