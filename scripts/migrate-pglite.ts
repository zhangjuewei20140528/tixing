import { config } from "dotenv";
config({ path: ".env.local" });

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { mkdir } from "node:fs/promises";

async function main() {
  const dataDir = process.env.PGLITE_DATA_DIR || ".data/pglite";
  await mkdir(dataDir, { recursive: true });
  const client = new PGlite(dataDir);
  const db = drizzle(client);
  await migrate(db, { migrationsFolder: "drizzle" });
  await client.close();
  console.log("Embedded PostgreSQL migrations applied");
}

main().catch((error) => { console.error(error); process.exit(1); });
