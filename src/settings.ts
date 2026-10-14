// Instance-wide settings, changed from the admin panel.

import { sql } from "./db";

export type SignupMode = "invite" | "open" | "closed";

const DEFAULTS = { signup_mode: "invite" as SignupMode };
type Key = keyof typeof DEFAULTS;

export async function getSetting<K extends Key>(key: K): Promise<(typeof DEFAULTS)[K]> {
	const [row] = await sql`select value from settings where key = ${key}`;
	return row ? row.value : DEFAULTS[key];
}

export async function setSetting<K extends Key>(key: K, value: (typeof DEFAULTS)[K]) {
	await sql`insert into settings (key, value) values (${key}, ${JSON.stringify(value)}::text::jsonb)
		on conflict (key) do update set value = excluded.value`;
}

export async function allSettings() {
	const out: Record<string, unknown> = { ...DEFAULTS };
	for (const r of await sql`select key, value from settings`) out[r.key] = r.value;
	return out;
}
