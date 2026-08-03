import { PGlite } from "@electric-sql/pglite";
import { mkdirSync } from "node:fs";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { drizzle as drizzlePostgres } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

const embedded = process.env.DATABASE_MODE === "pglite";
const globalForDb = globalThis as unknown as { pool?: Pool; pglite?: PGlite };
const dataDir = process.env.PGLITE_DATA_DIR || ".data/pglite";
if (embedded) mkdirSync(dataDir, { recursive: true });

export const pgliteClient = embedded ? (globalForDb.pglite ?? new PGlite(dataDir)) : null;
export const pool = embedded ? null : (globalForDb.pool ?? new Pool({ connectionString: process.env.DATABASE_URL, max: 10 }));

if (process.env.NODE_ENV !== "production") {
  if (pgliteClient) globalForDb.pglite = pgliteClient;
  if (pool) globalForDb.pool = pool;
}

// Both drivers expose the same relational query surface used by this app.
export const db = (embedded
  ? drizzlePglite(pgliteClient!, { schema })
  : drizzlePostgres(pool!, { schema })) as ReturnType<typeof drizzlePostgres<typeof schema>>;
