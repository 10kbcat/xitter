// Settings > Your account > Download an archive of your data. The archive is
// made on the spot (JSON) and kept in the database for the person to fetch.
import { sql } from "./db";
import { newId } from "./ids";
import type { Viewer } from "./auth";

const json = (body: unknown, status = 200) => Response.json(body, { status });

async function build(viewer: Viewer) {
	const id = viewer.id;
	const [user] = await sql`select screen_name, name, bio, location, website, email, language, protected, created_at from users where id = ${id}::bigint`;
	const posts = await sql`select id::text, text, created_at, reply_to_id::text from posts where user_id = ${id}::bigint order by id`;
	const likes = await sql`select post_id::text, created_at from likes where user_id = ${id}::bigint order by created_at`;
	const bookmarks = await sql`select post_id::text, created_at from bookmarks where user_id = ${id}::bigint order by created_at`;
	const following = await sql`select u.screen_name, f.created_at from follows f join users u on u.id = f.followee_id where f.follower_id = ${id}::bigint`;
	const followers = await sql`select u.screen_name, f.created_at from follows f join users u on u.id = f.follower_id where f.followee_id = ${id}::bigint`;
	const blocked = await sql`select u.screen_name from blocks b join users u on u.id = b.blocked_id where b.blocker_id = ${id}::bigint`;
	const muted = await sql`select u.screen_name from mutes m join users u on u.id = m.muted_id where m.muter_id = ${id}::bigint`;
	return { generated_at: new Date().toISOString(), account: user, posts, likes, bookmarks, following, followers, blocked, muted };
}

const entry = (r: any) => ({
	id: r.id,
	status: "COMPLETED",
	created_at: new Date(r.created_at).toISOString(),
	urls: [`/i/api/xitter/export/${r.id}`],
});

export async function dataExportRoute(method: string, path: string, viewer: Viewer, req: Request): Promise<Response | undefined> {
	if (path === "/1.1/account/user_twitter_data") {
		if (method === "GET") {
			const rows = await sql`select id::text, created_at from data_exports where user_id = ${viewer.id}::bigint order by created_at desc limit 5`;
			return json(rows.map(entry));
		}
		if (method === "POST") {
			const body = await build(viewer);
			const id = newId();
			await sql`delete from data_exports where user_id = ${viewer.id}::bigint and created_at < now() - interval '7 days'`;
			await sql`insert into data_exports (id, user_id, body) values (${id}::bigint, ${viewer.id}::bigint, ${JSON.stringify(body)}::text::jsonb)`;
			return json({ status: "ok" });
		}
		if (method === "PUT") return json({ status: "ok" });
	}
	if (path === "/1.1/account/personalization/email_your_data" && method === "POST") return json({ status: "ok" });
	const m = /^\/xitter\/export\/(\d{1,19})$/.exec(path);
	if (m && method === "GET") {
		const [row] = await sql`select body from data_exports where id = ${m[1]}::bigint and user_id = ${viewer.id}::bigint`;
		if (!row) return json({ errors: [{ code: 34, message: "Sorry, that page does not exist." }] }, 404);
		return new Response(JSON.stringify(row.body, null, 2), {
			headers: { "content-type": "application/json", "content-disposition": `attachment; filename="${viewer.screen_name}-data.json"`, "cache-control": "no-store" },
		});
	}
	return undefined;
}
