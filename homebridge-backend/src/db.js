// src/db.js
import { Pool } from "pg";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Neon works with sslmode=require, but some hosts still want this:
  ssl: { rejectUnauthorized: false }
});

// Simple helper
export const query = (text, params) => pool.query(text, params);

// Transaction helper (use when you need multiple statements atomically)
export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
