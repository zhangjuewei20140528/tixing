import { config } from "dotenv";
import { PGlite } from "@electric-sql/pglite";

config({ path: ".env.local" });

async function main() {
  const client = new PGlite(process.env.PGLITE_DATA_DIR || ".data/pglite");
  try {
    const result = await client.query(`
      select
        (select count(*) from users)::int as users,
        (select count(*) from wechat_bindings where status = 'active')::int as active_bindings,
        (select count(*) from reminders)::int as reminders,
        (select count(*) from delivery_attempts where status = 'sent')::int as sent_deliveries
    `);
    console.log(JSON.stringify(result.rows[0]));
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
