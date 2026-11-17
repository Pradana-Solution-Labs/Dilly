import postgres from "postgres";
import { config } from "../src/config.js";

async function run() {
  const sql = postgres(config.databaseUrl);
  console.log("Applying migration to:", config.databaseUrl);

  await sql`ALTER TABLE services ADD COLUMN IF NOT EXISTS webhook_secret text;`;
  await sql`ALTER TABLE services ADD COLUMN IF NOT EXISTS webhook_enabled boolean NOT NULL DEFAULT true;`;
  await sql`ALTER TABLE services ADD COLUMN IF NOT EXISTS ssh_public_key text;`;
  await sql`ALTER TABLE services ADD COLUMN IF NOT EXISTS ssh_private_key text;`;
  await sql`ALTER TABLE deployments ADD COLUMN IF NOT EXISTS triggered_by text NOT NULL DEFAULT 'manual';`;

  console.log("Migration applied successfully!");
  await sql.end();
}

run().catch((err) => {
  console.error("Migration error:", err);
  process.exit(1);
});
