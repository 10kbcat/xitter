import { SQL } from "bun";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const sql = new SQL(process.env.DATABASE_URL ?? "postgres://dev@localhost:5432/xitter");

// schema.sql is idempotent, so it doubles as the migration
export async function migrate() {
	await sql.unsafe(readFileSync(join(import.meta.dir, "schema.sql"), "utf8"));
}
