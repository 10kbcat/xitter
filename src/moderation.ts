// Temporary sanctions running out, and custom badge images.

import { sql } from "./db";
import { newId } from "./ids";

// an account whose sanction has ended goes back to its earlier standing
export async function expireSanctions() {
	await sql.begin(async (tx) => {
		const users = await tx`update users set status = coalesce(status_restore, 'active'), status_until = null, status_restore = null
			where status_until <= now() returning id::text`;
		for (const user of users) await tx`insert into audit_log (id, action, target) values (${newId()}::bigint, 'expire_sanction', ${user.id})`;
	});
}

export async function badgeImage(id: string) {
	if (BigInt(id) > 9223372036854775807n) return new Response(null, { status: 404 });
	const [badge] = await sql`select image, mime from custom_badges where id = ${id}::bigint`;
	if (!badge) return new Response(null, { status: 404 });
	return new Response(new Uint8Array(badge.image), { headers: { "content-type": badge.mime, "cache-control": "no-cache", "x-content-type-options": "nosniff" } });
}
