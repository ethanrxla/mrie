import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import postgres from "postgres";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required to run migrations");

const migrationsRoot = path.join(process.cwd(), "prisma", "migrations");
const sql = postgres(databaseUrl, { max: 1 });

try {
  await sql`
    CREATE TABLE IF NOT EXISTS xyn_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  const directories = (await readdir(migrationsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const name of directories) {
    const [existing] = await sql`SELECT name FROM xyn_migrations WHERE name = ${name}`;
    if (existing) continue;
    const source = await readFile(path.join(migrationsRoot, name, "migration.sql"), "utf8");
    await sql.begin(async (transaction) => {
      await transaction.unsafe(source);
      await transaction`INSERT INTO xyn_migrations (name) VALUES (${name})`;
    });
    console.log(`Applied migration ${name}`);
  }
} finally {
  await sql.end();
}
