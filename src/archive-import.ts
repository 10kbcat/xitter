// Settings > Import from X (/account/import): someone uploads the archive they
// downloaded from x.com (Settings > Your account > Download an archive), and
// their posts, photos, videos and profile come over with their original dates.
//
// The zip can be gigabytes, past the server's request size, so the page sends
// it in pieces (POST /account/import/upload?offset=n) to ARCHIVE_DIR, then
// starts the import. One import runs at a time, in the background; the page
// shows its progress, and one cut off by a restart carries on.
//
// Posts keep their X ids when they can: ids sort by time, X's use the same
// layout and epoch, so an imported post sits at its date in every timeline,
// a thread's replies find their parents, and importing again skips what's
// there. They stay on this instance (other instances aren't sent years of old
// posts), @mentions are left as text (an X name here may be someone else), and
// retweets and likes aren't imported (they're other people's posts).

import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { appendFile, truncate } from "node:fs/promises";
import { join } from "node:path";
import { accountPage, esc } from "./account-page";
import type { Viewer } from "./auth";
import { sql } from "./db";
import { idTime, isId, newId } from "./ids";
import { MEDIA_DIR, sniffImage } from "./media";
import { queueVideo, sourceFile } from "./video";
import { Zip, ZipError, type ZipEntry } from "./zip";

const DIR = process.env.ARCHIVE_DIR ?? "data/imports";
const MAX_BYTES = Number(process.env.ARCHIVE_MAX_MB ?? 4096) * 1024 * 1024;
const CHUNK_BYTES = 8 * 1024 * 1024;
const MAX_JS = 512 * 1024 * 1024;
const MAX_PHOTO = 25 * 1024 * 1024;
const MAX_VIDEO = 1024 * 1024 * 1024;
const EPOCH = 1288834974657n;

const fileOf = (userId: string) => join(DIR, `${userId}.zip`);

type Options = { replies: boolean; profile: boolean };
type State = "uploading" | "queued" | "running" | "done" | "failed";
type Row = { state: State; size: number; options: Options; total: number; posts: number; media: number; skipped: number; error: string | null };

async function row(userId: string): Promise<Row | undefined> {
	const [r] = await sql`select state, size::float8 as size, options, total, posts, media, skipped, error from archive_imports where user_id = ${userId}::bigint`;
	return r as Row | undefined;
}

class ImportError extends Error {}

// ── reading the archive ────────────────────────────────────────────────────

// data/tweets.js is "window.YTD.tweets.part0 = [...]": JSON after the "="
function ytd(text: string, name: string): any[] {
	const at = text.indexOf("=");
	try {
		const value = JSON.parse(at >= 0 ? text.slice(at + 1) : text);
		return Array.isArray(value) ? value : [];
	} catch {
		throw new ImportError(`${name.slice(name.lastIndexOf("/") + 1)} in the archive couldn't be read.`);
	}
}

// archives sit at the top of the zip or inside one folder ("twitter-2024-…/data/…")
const inData = (e: ZipEntry, pattern: RegExp) => pattern.test(e.name.replace(/^[^/]*\/(?=data\/)/, ""));

async function readJs(zip: Zip, pattern: RegExp): Promise<any[]> {
	const out: any[] = [];
	for (const e of zip.entries.filter((x) => inData(x, pattern)).sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true })))
		out.push(...ytd((await zip.read(e, MAX_JS)).toString("utf8"), e.name));
	return out;
}

// the files in a media folder by name ("1234-abc.jpg"), wherever the folder sits
function mediaFiles(zip: Zip, folder: RegExp): Map<string, ZipEntry> {
	const out = new Map<string, ZipEntry>();
	for (const e of zip.entries) if (inData(e, folder) && !e.name.endsWith("/")) out.set(e.name.slice(e.name.lastIndexOf("/") + 1), e);
	return out;
}

const MONTHS: Record<string, number> = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
// "Wed Oct 10 20:19:24 +0000 2018"
function xDate(s: unknown): Date | undefined {
	const m = typeof s === "string" ? /^\w{3} (\w{3}) (\d{2}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2}) (\d{4})$/.exec(s) : null;
	if (!m || MONTHS[m[1]] === undefined) return typeof s === "string" && !Number.isNaN(Date.parse(s)) ? new Date(s) : undefined;
	const offset = (m[6] === "-" ? -1 : 1) * (Number(m[7]) * 60 + Number(m[8])) * 60_000;
	return new Date(Date.UTC(Number(m[9]), MONTHS[m[1]], Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])) - offset);
}

// an id for a moment, when the X id can't be used
function idAt(date: Date): string {
	const random = BigInt(Math.floor(Math.random() * 0x3fffff));
	return (((BigInt(date.getTime()) - EPOCH) << 22n) | random).toString();
}

const decode = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const basename = (url: unknown) => (typeof url === "string" ? (url.split("?")[0].split("/").pop() ?? "") : "");

// the post's text as written: no "@name" a reply starts with, no t.co links
function postText(t: any, note: any | undefined): string {
	if (note?.core?.text) {
		let text = String(note.core.text);
		for (const u of note.core.urls ?? []) if (u?.shortUrl && u?.expandedUrl) text = text.split(u.shortUrl).join(u.expandedUrl);
		return text.trim();
	}
	// the range counts the text as X sends it, with &amp; still escaped
	const chars = [...String(t.full_text ?? t.text ?? "")];
	const range = Array.isArray(t.display_text_range) ? t.display_text_range.map(Number) : [0, chars.length];
	let text = decode(chars.slice(range[0] || 0, range[1] || chars.length).join(""));
	for (const u of t.entities?.urls ?? []) if (u?.url && u?.expanded_url) text = text.split(u.url).join(u.expanded_url);
	for (const m of t.extended_entities?.media ?? t.entities?.media ?? []) if (m?.url) text = text.split(m.url).join("");
	return text.trim();
}

const appName = (source: unknown) => (typeof source === "string" ? source.replace(/<[^>]*>/g, "").trim().slice(0, 60) : "") || "Twitter";

// ── importing ──────────────────────────────────────────────────────────────

// the fields given change; the others keep their value
async function progress(userId: string, set: Partial<Row>) {
	await sql`update archive_imports set state = coalesce(${set.state ?? null}::text, state), total = coalesce(${set.total ?? null}::int, total),
		posts = coalesce(${set.posts ?? null}::int, posts), media = coalesce(${set.media ?? null}::int, media), skipped = coalesce(${set.skipped ?? null}::int, skipped),
		error = case when ${"error" in set}::boolean then ${set.error ?? null}::text else error end, updated_at = now()
		where user_id = ${userId}::bigint`;
}

async function savePhoto(userId: string, data: Buffer, post: { id: string; position: number } | null): Promise<string | undefined> {
	const image = sniffImage(data);
	if (!image || data.length > MAX_PHOTO) return undefined;
	const id = newId();
	mkdirSync(MEDIA_DIR, { recursive: true });
	writeFileSync(join(MEDIA_DIR, id), data);
	await sql`insert into media (id, user_id, kind, mime, size, width, height, post_id, position)
		values (${id}::bigint, ${userId}::bigint, 'photo', ${image.mime}, ${data.length}, ${image.width}, ${image.height}, ${post?.id ?? null}::bigint, ${post?.position ?? null})`;
	return id;
}

// the video goes through the same conversion as an upload (video.ts)
async function saveVideo(userId: string, data: Buffer, post: { id: string; position: number }) {
	const id = newId();
	mkdirSync(MEDIA_DIR, { recursive: true });
	writeFileSync(sourceFile(MEDIA_DIR, id), data);
	await sql`insert into media (id, user_id, kind, mime, size, width, height, state, post_id, position)
		values (${id}::bigint, ${userId}::bigint, 'video', 'video/mp4', ${data.length}, 0, 0, 'processing', ${post.id}::bigint, ${post.position})`;
	queueVideo(MEDIA_DIR, id);
}

async function importProfile(userId: string, zip: Zip) {
	const [account] = (await readJs(zip, /^data\/account\.js$/)).map((a) => a.account ?? a);
	const [profile] = (await readJs(zip, /^data\/profile\.js$/)).map((p) => p.profile ?? p);
	const name = typeof account?.accountDisplayName === "string" ? account.accountDisplayName.trim().slice(0, 50) : "";
	const d = profile?.description ?? {};
	const bio = typeof d.bio === "string" ? d.bio.slice(0, 160) : null;
	const location = typeof d.location === "string" ? d.location.slice(0, 30) : null;
	const website = typeof d.website === "string" && /^https?:\/\/\S+$/.test(d.website) ? d.website.slice(0, 100) : null;
	await sql`update users set name = coalesce(nullif(${name}, ''), name), bio = coalesce(${bio}, bio), location = coalesce(${location}, location),
		website = coalesce(${website}, website) where id = ${userId}::bigint`;
	const files = mediaFiles(zip, /^data\/profile_media\//);
	const find = (url: unknown) => [...files.entries()].find(([n]) => basename(url) && n.endsWith(`-${basename(url)}`))?.[1];
	const avatar = find(profile?.avatarMediaUrl);
	const banner = find(profile?.headerMediaUrl);
	if (avatar) {
		const id = await savePhoto(userId, await zip.read(avatar, MAX_PHOTO), null);
		if (id) await sql`update users set avatar_url = ${`/media/${id}`} where id = ${userId}::bigint`;
	}
	if (banner) {
		const id = await savePhoto(userId, await zip.read(banner, MAX_PHOTO), null);
		if (id) await sql`update users set banner_url = ${`/media/banner/${id}`} where id = ${userId}::bigint`;
	}
}

// the import of the archive waiting in ARCHIVE_DIR for this account, with the
// options its archive_imports row holds (scripts/test-archive-import.ts calls it)
export async function runImport(userId: string) {
	const r = await row(userId);
	if (!r || !existsSync(fileOf(userId))) return;
	await progress(userId, { state: "running", error: null });
	try {
		const zip = await Zip.open(fileOf(userId));
		const [account] = (await readJs(zip, /^data\/account\.js$/)).map((a) => a.account ?? a);
		const xUserId = String(account?.accountId ?? "");
		const tweets = (await readJs(zip, /^data\/tweets?(-part\d+)?\.js$/)).map((t) => t.tweet ?? t).filter((t) => isId(t?.id_str));
		if (!tweets.length && !account) throw new ImportError("This doesn't look like an X archive: it has no data/tweets.js.");
		// long posts: the tweet holds the first 280 characters, the note the rest
		const notes = new Map<number, any>();
		for (const n of (await readJs(zip, /^data\/note-tweet(-part\d+)?\.js$/)).map((x) => x.noteTweet ?? x)) {
			const at = Date.parse(n?.createdAt);
			if (!Number.isNaN(at)) notes.set(Math.floor(at / 1000), n);
		}
		const media = mediaFiles(zip, /^data\/tweets?_media\//);
		if (r.options.profile) await importProfile(userId, zip);

		// oldest first, so a reply's parent is already here
		tweets.sort((a, b) => (BigInt(a.id_str) < BigInt(b.id_str) ? -1 : 1));
		await progress(userId, { total: tweets.length });
		const now = Date.now();
		let posts = 0;
		let mediaCount = 0;
		let skipped = 0;
		for (const [i, t] of tweets.entries()) {
			if (i % 50 === 0) await progress(userId, { posts, media: mediaCount, skipped });
			const date = xDate(t.created_at);
			const retweet = t.retweeted === true || /^RT @\w+:/.test(String(t.full_text ?? ""));
			const replyTo = isId(t.in_reply_to_status_id_str) ? t.in_reply_to_status_id_str : null;
			const toSelf = !!replyTo && (!t.in_reply_to_user_id_str || String(t.in_reply_to_user_id_str) === xUserId);
			if (!date || date.getTime() > now || retweet || (replyTo && !toSelf && !r.options.replies)) {
				skipped++;
				continue;
			}
			const text = postText(t, notes.get(Math.floor(date.getTime() / 1000)));
			const items = (t.extended_entities?.media ?? t.entities?.media ?? []).slice(0, 4);
			if (!text && !items.length) {
				skipped++;
				continue;
			}
			// the X id, unless it doesn't match the post's date (a hand-made archive)
			const id = Math.abs(idTime(t.id_str).getTime() - date.getTime()) < 86_400_000 ? t.id_str : idAt(date);
			const [parent] = replyTo && toSelf ? await sql`select id::text, conversation_id::text from posts where id = ${replyTo}::bigint and user_id = ${userId}::bigint` : [];
			const inserted = await sql.begin(async (tx) => {
				const rows = await tx`insert into posts (id, user_id, text, reply_to_id, reply_to_user_id, conversation_id, source, created_at, received_at)
					values (${id}::bigint, ${userId}::bigint, ${text}, ${parent?.id ?? null}::bigint, ${parent ? userId : null}::bigint,
						${parent?.conversation_id ?? id}::bigint, ${appName(t.source)}, ${date}, ${date})
					on conflict (id) do nothing returning id`;
				// years of old posts aren't news to other instances
				if (rows.length) await tx`delete from federation_outbox where kind = 'post' and a = ${id}::bigint`;
				return rows.length > 0;
			});
			if (!inserted) {
				skipped++;
				continue;
			}
			posts++;
			for (const [position, m] of items.entries()) {
				const video = m?.type === "video" || m?.type === "animated_gif";
				const best = video ? [...(m.video_info?.variants ?? [])].filter((v: any) => v?.content_type === "video/mp4").sort((a: any, b: any) => Number(b.bitrate ?? 0) - Number(a.bitrate ?? 0))[0] : null;
				const entry = media.get(`${t.id_str}-${basename(video ? best?.url : m?.media_url_https)}`);
				if (!entry) continue;
				try {
					if (video) {
						await saveVideo(userId, await zip.read(entry, MAX_VIDEO), { id, position });
						mediaCount++;
					} else if (await savePhoto(userId, await zip.read(entry, MAX_PHOTO), { id, position })) mediaCount++;
				} catch (e) {
					if (!(e instanceof ZipError)) throw e;
				}
			}
		}
		await progress(userId, { state: "done", posts, media: mediaCount, skipped });
	} catch (e) {
		const message = e instanceof ImportError || e instanceof ZipError ? e.message : "The import stopped with an error. Try again, or ask an admin to check the server log.";
		if (!(e instanceof ImportError || e instanceof ZipError)) console.error(`archive import for ${userId}:`, e);
		await progress(userId, { state: "failed", error: message });
	} finally {
		rmSync(fileOf(userId), { force: true });
	}
}

// one import at a time; each waits for the one before
let chain: Promise<void> = Promise.resolve();
const enqueue = (userId: string) => {
	chain = chain.then(() => runImport(userId)).catch((e) => console.error("archive import:", e));
};

// imports a restart cut off
export async function resumeImports() {
	for (const r of await sql`select user_id::text from archive_imports where state in ('queued', 'running') order by updated_at`) {
		if (existsSync(fileOf(r.user_id))) enqueue(r.user_id);
		else await sql`update archive_imports set state = 'failed', error = 'The archive was lost when the server restarted. Upload it again.' where user_id = ${r.user_id}::bigint`;
	}
}

// ── the page ───────────────────────────────────────────────────────────────

const plural = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

async function page(req: Request, viewer: Viewer, r: Row | undefined, error = "") {
	const busy = r?.state === "queued" || r?.state === "running";
	const summary = r && `${plural(r.posts, "post", "posts")} and ${plural(r.media, "photo or video", "photos and videos")} imported${r.skipped ? `, ${plural(r.skipped, "post", "posts")} skipped (retweets, replies to others, or already here)` : ""}`;
	const status = busy
		? `<div class="card"><b>${r!.state === "queued" ? "Waiting for another import to finish…" : "Importing…"}</b><div class="meta">${r!.total ? `${(r!.posts + r!.skipped).toLocaleString("en-US")} of ${plural(r!.total, "post", "posts")} done. ` : ""}${summary}. Videos are converted after the posts are in.</div></div>`
		: r?.state === "done"
			? `<div class="card success"><b>Import finished</b><div class="meta">${summary}. Videos may take a while longer to appear.</div></div>`
			: r?.state === "failed"
				? `<div class="card strike"><b>The import didn't finish</b><div class="meta">${esc(r.error ?? "")}</div></div>`
				: "";
	const form = busy
		? ""
		: `<form id="import" method="post" action="/account/import">
	<input type="hidden" name="csrf" value="${esc(viewer.csrf)}">
	<label for="file">Your X archive (.zip)</label>
	<input id="file" type="file" accept=".zip,application/zip" required>
	<label class="row" style="margin:0;color:inherit"><input type="checkbox" name="profile" value="1" style="width:auto;min-height:0" checked> Also bring over my name, bio, location, website, profile photo and header</label>
	<label class="row" style="margin:0;color:inherit"><input type="checkbox" name="replies" value="1" style="width:auto;min-height:0"> Include my replies to other people (they become posts of their own)</label>
	<p class="dim" id="progress" hidden></p>
	<button type="submit">Upload and import</button>
</form>
<script>
(function(){
	var form=document.getElementById("import"),file=document.getElementById("file"),out=document.getElementById("progress"),csrf=form.csrf.value,CHUNK=${CHUNK_BYTES};
	form.addEventListener("submit",async function(e){
		e.preventDefault();
		var f=file.files[0];if(!f)return;
		var button=form.querySelector("button");button.disabled=true;out.hidden=false;
		try{
			for(var at=0;at<f.size||at===0;at+=CHUNK){
				out.textContent="Uploading… "+Math.floor(at/Math.max(f.size,1)*100)+"%";
				var r=await fetch("/account/import/upload?offset="+at,{method:"POST",headers:{"x-csrf-token":csrf},body:f.slice(at,at+CHUNK)});
				if(!r.ok)throw new Error((await r.json().catch(function(){return{}})).error||"The upload failed.");
				if(f.size===0)break;
			}
			out.textContent="Uploaded. Starting the import…";
			form.submit();
		}catch(err){out.textContent=err.message;button.disabled=false}
	});
})();
</script>`;
	const res = await accountPage({
		req,
		viewer,
		title: "Import from X",
		status: error ? 400 : 200,
		body: `<h1>Import from X</h1>
	<p class="dim">Bring your posts over from X with their original dates, photos and videos, and threads kept together. On x.com, go to Settings, Your account, Download an archive of your data. X emails you when it's ready, then upload the zip here.</p>
	<p class="dim">Retweets and likes aren't imported, @mentions stay as plain text (the name here may belong to someone else), and imported posts stay on this instance. Importing the same archive again skips posts that are already here.</p>
	${error ? `<p class="error">${esc(error)}</p>` : ""}
	${status}
	${form}`,
	});
	// while it runs, the page reloads itself to show the progress
	if (busy) res.headers.set("refresh", "5");
	return res;
}

const json = (body: unknown, status = 200) => Response.json(body, { status });

export async function importRoute(req: Request, url: URL, viewer: Viewer): Promise<Response> {
	const p = url.pathname;
	const r = await row(viewer.id);
	const busy = r?.state === "queued" || r?.state === "running";
	if (p === "/account/import/upload") {
		if (req.method !== "POST") return json({ error: "Use POST." }, 405);
		if (req.headers.get("x-csrf-token") !== viewer.csrf) return json({ error: "That page is out of date. Reload it and try again." }, 403);
		if (busy) return json({ error: "An import is already running." }, 409);
		const offset = Number(url.searchParams.get("offset"));
		const data = new Uint8Array(await req.arrayBuffer());
		if (!Number.isSafeInteger(offset) || offset < 0 || data.length > CHUNK_BYTES) return json({ error: "Bad upload piece." }, 400);
		mkdirSync(DIR, { recursive: true });
		const file = fileOf(viewer.id);
		if (offset === 0) {
			await sql`insert into archive_imports (user_id, state, size) values (${viewer.id}::bigint, 'uploading', 0)
				on conflict (user_id) do update set state = 'uploading', size = 0, total = 0, posts = 0, media = 0, skipped = 0, error = null, updated_at = now()`;
			writeFileSync(file, "");
		}
		const size = existsSync(file) ? statSync(file).size : -1;
		if (size !== offset) return json({ error: "The upload got out of step. Start again." }, 409);
		if (size + data.length > MAX_BYTES) {
			await truncate(file, 0);
			return json({ error: `Archives up to ${Math.round(MAX_BYTES / 1024 / 1024)} MB can be imported.` }, 413);
		}
		await appendFile(file, data);
		await sql`update archive_imports set size = ${size + data.length}, updated_at = now() where user_id = ${viewer.id}::bigint`;
		return json({ size: size + data.length });
	}
	if (req.method !== "POST") return page(req, viewer, r);
	const f = await req.formData().catch(() => undefined);
	if (String(f?.get("csrf") ?? "") !== viewer.csrf) return page(req, viewer, r, "That form is out of date. Try again.");
	if (busy) return page(req, viewer, r, "An import is already running.");
	if (r?.state !== "uploading" || !existsSync(fileOf(viewer.id))) return page(req, viewer, r, "Upload your archive first.");
	const [me] = await sql`select status from users where id = ${viewer.id}::bigint`;
	if (me?.status !== "active") return page(req, viewer, r, "Your account can't post right now, so it can't import posts either.");
	try {
		await Zip.open(fileOf(viewer.id));
	} catch (e) {
		rmSync(fileOf(viewer.id), { force: true });
		await sql`update archive_imports set state = 'failed', error = ${e instanceof ZipError ? e.message : "That file couldn't be read."} where user_id = ${viewer.id}::bigint`;
		return new Response(null, { status: 303, headers: { location: "/account/import" } });
	}
	const options: Options = { replies: f?.get("replies") === "1", profile: f?.get("profile") === "1" };
	await sql`update archive_imports set state = 'queued', options = ${JSON.stringify(options)}::text::jsonb, updated_at = now() where user_id = ${viewer.id}::bigint`;
	enqueue(viewer.id);
	return new Response(null, { status: 303, headers: { location: "/account/import" } });
}
