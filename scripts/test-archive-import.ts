// Imports a small hand-made X archive into a migrated, disposable database and
// checks what lands: posts with their X ids and dates, a thread kept together,
// a photo, the profile, nothing sent to other instances, and a second import
// that adds nothing.
// DATABASE_URL=postgres://localhost/xitter_test bun scripts/test-archive-import.ts
import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const database = new URL(process.env.DATABASE_URL ?? "postgres://localhost/xitter");
assert(["localhost", "127.0.0.1"].includes(database.hostname) && /test|codex/.test(database.pathname), "Use a disposable local test database.");
const scratch = mkdtempSync(join(tmpdir(), "xitter-archive-"));
process.env.ARCHIVE_DIR = join(scratch, "imports");
process.env.MEDIA_DIR = join(scratch, "media");
const { sql } = await import("../src/db");
const { newId } = await import("../src/ids");
const { runImport } = await import("../src/archive-import");

// a zip with stored entries; the reader doesn't check CRCs, so they're left at 0
function zip(files: Record<string, Buffer | string>): Buffer {
	const parts: Buffer[] = [];
	const dir: Buffer[] = [];
	let offset = 0;
	for (const [name, content] of Object.entries(files)) {
		const data = Buffer.from(content);
		const n = Buffer.from(name);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt32LE(data.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(n.length, 26);
		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(20, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt32LE(data.length, 20);
		central.writeUInt32LE(data.length, 24);
		central.writeUInt16LE(n.length, 28);
		central.writeUInt32LE(offset, 42);
		parts.push(local, n, data);
		dir.push(central, n);
		offset += 30 + n.length + data.length;
	}
	const directory = Buffer.concat(dir);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(dir.length / 2, 8);
	end.writeUInt16LE(dir.length / 2, 10);
	end.writeUInt32LE(directory.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...parts, directory, end]);
}

// X's ids: milliseconds since its epoch, then worker bits
const xId = (date: Date) => (((BigInt(date.getTime()) - 1288834974657n) << 22n) | (5n << 12n)).toString();
const xDate = (d: Date) => d.toUTCString().replace(/^(\w{3}), (\d{2}) (\w{3}) (\d{4}) (\S+) GMT$/, "$1 $3 $2 $5 +0000 $4");
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

const first = new Date("2019-03-04T05:06:07Z");
const second = new Date("2019-03-04T06:00:00Z");
const t1 = xId(first), t2 = xId(second), t3 = xId(new Date("2019-04-01T00:00:00Z")), t4 = xId(new Date("2019-05-01T00:00:00Z"));
const ytd = (kind: string, rows: unknown[]) => `window.YTD.${kind}.part0 = ${JSON.stringify(rows)}`;
const archive = zip({
	"twitter-2026-10-19/data/account.js": ytd("account", [{ account: { accountId: "111", username: "old_me", accountDisplayName: "Imported Name" } }]),
	"twitter-2026-10-19/data/profile.js": ytd("profile", [{ profile: { description: { bio: "Moved over", website: "https://example.org", location: "Here" } } }]),
	"twitter-2026-10-19/data/tweets.js": ytd("tweets", [
		{ tweet: { id_str: t2, created_at: xDate(second), full_text: "@old_me and a second", display_text_range: ["7", "20"], in_reply_to_status_id_str: t1, in_reply_to_user_id_str: "111", source: '<a href="x">Twitter for iPhone</a>' } },
		{
			tweet: {
				id_str: t1, created_at: xDate(first), full_text: "first &amp; best https://t.co/aaa https://t.co/ppp", display_text_range: ["0", "33"],
				entities: { urls: [{ url: "https://t.co/aaa", expanded_url: "https://example.org/page" }] },
				extended_entities: { media: [{ type: "photo", url: "https://t.co/ppp", media_url_https: "https://pbs.twimg.com/media/abc.png" }] },
			},
		},
		{ tweet: { id_str: t3, created_at: xDate(new Date("2019-04-01T00:00:00Z")), full_text: "RT @someone: not mine" } },
		{ tweet: { id_str: t4, created_at: xDate(new Date("2019-05-01T00:00:00Z")), full_text: "@stranger hi", display_text_range: ["10", "12"], in_reply_to_status_id_str: "1", in_reply_to_user_id_str: "999" } },
	]),
	[`twitter-2026-10-19/data/tweets_media/${t1}-abc.png`]: png,
});

const user = newId();
const start = async () => {
	await sql`insert into archive_imports (user_id, state, options) values (${user}::bigint, 'queued', '{"replies": false, "profile": true}'::jsonb)
		on conflict (user_id) do update set state = 'queued', error = null`;
	const { mkdirSync } = await import("node:fs");
	mkdirSync(process.env.ARCHIVE_DIR!, { recursive: true });
	writeFileSync(join(process.env.ARCHIVE_DIR!, `${user}.zip`), archive);
	await runImport(user);
};
try {
	await sql`insert into users (id, screen_name, name, password_hash) values (${user}::bigint, ${`imp_${user}`.slice(0, 15)}, 'Before', 'not-a-secret')`;
	await start();
	const [state] = await sql`select state, posts, skipped, error from archive_imports where user_id = ${user}::bigint`;
	assert.equal(state.state, "done", state.error);
	assert.equal(state.posts, 2, "the post and its reply");
	assert.equal(state.skipped, 2, "the retweet and the reply to someone else");
	const posts = await sql`select id::text, text, reply_to_id::text, conversation_id::text, created_at, source from posts where user_id = ${user}::bigint order by id`;
	assert.deepEqual(posts.map((p: any) => p.id), [t1, t2], "posts keep their X ids");
	assert.equal(posts[0].text, "first & best https://example.org/page", "links expanded, the photo's link gone, &amp; decoded");
	assert.equal(new Date(posts[0].created_at).toISOString(), first.toISOString(), "the original date");
	assert.equal(posts[1].text, "and a second", "a reply loses the @name it starts with");
	assert.equal(posts[1].reply_to_id, t1, "a thread stays a thread");
	assert.equal(posts[1].conversation_id, t1);
	assert.equal(posts[1].source, "Twitter for iPhone");
	const [photo] = await sql`select mime, width, height, position from media where post_id = ${t1}::bigint`;
	assert.equal(photo?.mime, "image/png", "the photo comes along");
	assert.equal(photo.position, 0);
	const outbox = await sql`select 1 from federation_outbox where kind = 'post' and a = any(${sql.array([t1, t2], "INT8")})`;
	assert.equal(outbox.length, 0, "imported posts aren't sent to other instances");
	const [me] = await sql`select name, bio, location, website from users where id = ${user}::bigint`;
	assert.deepEqual({ ...me }, { name: "Imported Name", bio: "Moved over", location: "Here", website: "https://example.org" }, "the profile");
	assert(!existsSync(join(process.env.ARCHIVE_DIR!, `${user}.zip`)), "the archive is deleted after the import");

	await start();
	const [again] = await sql`select state, posts, skipped from archive_imports where user_id = ${user}::bigint`;
	assert.equal(again.state, "done");
	assert.equal(again.posts, 0, "importing again adds nothing");
	assert.equal((await sql`select count(*)::int as n from posts where user_id = ${user}::bigint`)[0].n, 2);
	console.log("archive import: all passed");
} finally {
	await sql`delete from users where id = ${user}::bigint`;
	await sql.close();
	rmSync(scratch, { recursive: true, force: true });
}
