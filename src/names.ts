// Blocked names (admin panel > Settings): words no handle or display name may
// contain. Sign-up with one is refused; an account that renames itself to one
// is suspended on the spot. Matching ignores case, accents, separators,
// look-alike digits and symbols, and repeated letters, so "N_1-gg3rr" matches
// "nigger".

import { sql } from "./db";
import { newId } from "./ids";
import { settings } from "./settings";

const LOOKALIKE: Record<string, string> = { "0": "o", "1": "i", "!": "i", "|": "i", "3": "e", "4": "a", "@": "a", "5": "s", "$": "s", "7": "t", "8": "b", "9": "g", "6": "g", "+": "t" };

export function normalizeName(text: string): string {
	return text
		.normalize("NFKD")
		.replace(/\p{M}/gu, "")
		.toLowerCase()
		.replace(/[0-9!|@$+]/g, (c) => LOOKALIKE[c] ?? c)
		.replace(/[^\p{L}]/gu, "")
		.replace(/(\p{L})\1+/gu, "$1");
}

// the first blocked word the text contains, if any
export function blockedNameIn(...texts: string[]): string | undefined {
	const words = settings().operations.blocked_names.map(normalizeName).filter(Boolean);
	if (!words.length) return undefined;
	const all = texts.map(normalizeName);
	return words.find((w) => all.some((t) => t.includes(w)));
}

// An account that took a blocked name: suspended and signed out everywhere,
// with a line in the audit log. Staff are left alone (the caller refuses).
export async function suspendForName(userId: string, name: string) {
	await sql`update users set status = 'suspended', status_until = null where id = ${userId}::bigint and role is null`;
	await sql`delete from sessions where user_id = ${userId}::bigint and exists (select 1 from users where id = ${userId}::bigint and role is null)`;
	await sql`insert into audit_log (id, actor_id, action, target, detail) values (${newId()}::bigint, null, 'auto_suspend_name', ${userId}, ${JSON.stringify({ name })}::text::jsonb)`;
}
