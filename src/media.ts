// Uploaded images: the client's chunked upload (INIT, APPEND, FINALIZE,
// STATUS), storage on disk, serving, and the media objects attached to posts.
// Images are stored as uploaded; GIFs are served as images, so they animate
// without a video conversion step.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Viewer } from "./auth";
import { PUBLIC_HOSTNAME, PUBLIC_ORIGIN } from "./config";
import { sql } from "./db";
import { isId, newId } from "./ids";

export const MEDIA_DIR = process.env.MEDIA_DIR ?? "media";
const MAX_IMAGE = 5 * 1024 * 1024;
const MAX_GIF = 15 * 1024 * 1024;
const MAX_PENDING_MS = 60 * 60 * 1000;

type Pending = { userId: string; total: number; category: string; chunks: Map<number, Buffer>; started: number };
const pending = new Map<string, Pending>();

export type MediaRow = { id: string; kind: string; mime: string; size: number; width: number; height: number; position: number | null };

type Image = { mime: string; width: number; height: number };

// type and dimensions from the file header; nothing else is trusted
export function sniffImage(b: Buffer): Image | undefined {
	if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47) return { mime: "image/png", width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
	if (b.length >= 10 && b.toString("latin1", 0, 3) === "GIF") return { mime: "image/gif", width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
	if (b.length >= 30 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") {
		const chunk = b.toString("latin1", 12, 16);
		if (chunk === "VP8X") return { mime: "image/webp", width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
		if (chunk === "VP8L") {
			const bits = b.readUInt32LE(21);
			return { mime: "image/webp", width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
		}
		if (chunk === "VP8 ") return { mime: "image/webp", width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
	}
	if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
		// walk segments to the first start-of-frame marker
		let i = 2;
		while (i + 9 < b.length) {
			if (b[i] !== 0xff) return undefined;
			const marker = b[i + 1];
			const len = b.readUInt16BE(i + 2);
			if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
				return { mime: "image/jpeg", width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
			i += 2 + len;
		}
	}
	return undefined;
}

const fileOf = (id: string) => join(MEDIA_DIR, id);
const EXT: Record<string, string> = { "image/png": "png", "image/gif": "gif", "image/webp": "webp", "image/jpeg": "jpg" };
export const mediaUrl = (id: string, mime: string) => `${PUBLIC_ORIGIN}/media/${id}.${EXT[mime] ?? "bin"}`;
// stored paths are relative so the instance can move to another domain
export const absolute = (path: string | null) => (path?.startsWith("/") ? PUBLIC_ORIGIN + path : path);

const uploadError = (message: string, status = 400) => Response.json({ error: message, errors: [{ code: 324, message }] }, { status });

async function params(req: Request, url: URL): Promise<{ fields: Record<string, string>; file?: Buffer }> {
	const fields: Record<string, string> = Object.fromEntries(url.searchParams);
	let file: Buffer | undefined;
	const type = req.headers.get("content-type") ?? "";
	if (req.method === "POST" && /multipart\/form-data|x-www-form-urlencoded/.test(type)) {
		const form = await req.formData();
		for (const [k, v] of form) {
			if (typeof v === "string") fields[k] = v;
			else if (k === "media") file = Buffer.from(await v.arrayBuffer());
		}
	}
	if (!file && fields.media_data) file = Buffer.from(fields.media_data, "base64");
	return { fields, file };
}

function idFields(id: string) {
	// media_id as a number loses precision in JSON; clients read media_id_string
	return { media_id: Number(id), media_id_string: id, media_key: `3_${id}` };
}

async function finalize(id: string, p: Pending): Promise<Response> {
	pending.delete(id);
	const parts = [...p.chunks].sort((a, b) => a[0] - b[0]).map((c) => c[1]);
	const data = Buffer.concat(parts);
	if (data.length !== p.total) return uploadError("File size does not match the size announced at INIT.");
	const image = sniffImage(data);
	if (!image) return uploadError("Unsupported file. Images only: JPEG, PNG, GIF or WebP.");
	if (data.length > (image.mime === "image/gif" ? MAX_GIF : MAX_IMAGE)) return uploadError("File is too large.");
	mkdirSync(MEDIA_DIR, { recursive: true });
	writeFileSync(fileOf(id), data);
	await sql`insert into media (id, user_id, kind, mime, size, width, height)
		values (${id}::bigint, ${p.userId}::bigint, 'photo', ${image.mime}, ${data.length}, ${image.width}, ${image.height})`;
	return Response.json({
		...idFields(id),
		size: data.length,
		expires_after_secs: 86400,
		image: { image_type: image.mime, w: image.width, h: image.height },
		// the gif flow polls STATUS until processing reports success
		...(/gif|video/.test(p.category) ? { processing_info: { state: "succeeded", progress_percent: 100 } } : {}),
	});
}

export async function mediaUpload(req: Request, url: URL, viewer: Viewer): Promise<Response> {
	const { fields, file } = await params(req, url);
	const id = fields.media_id;
	for (const [key, p] of pending) if (Date.now() - p.started > MAX_PENDING_MS) pending.delete(key);

	switch (fields.command) {
		case "INIT": {
			const total = Number(fields.total_bytes);
			if (!Number.isInteger(total) || total <= 0 || total > MAX_GIF) return uploadError("File is too large or empty.");
			if (fields.media_type && !/^image\//.test(fields.media_type)) return uploadError("Only images can be uploaded for now.");
			const newMedia = newId();
			pending.set(newMedia, { userId: viewer.id, total, category: fields.media_category ?? "", chunks: new Map(), started: Date.now() });
			return Response.json({ ...idFields(newMedia), expires_after_secs: 86400 }, { status: 202 });
		}
		case "APPEND": {
			const p = id ? pending.get(id) : undefined;
			if (!p || p.userId !== viewer.id) return uploadError("Unknown upload.", 404);
			if (!file) return uploadError("No data in APPEND.");
			const received = [...p.chunks.values()].reduce((n, c) => n + c.length, 0);
			if (received + file.length > p.total) return uploadError("More data than announced at INIT.");
			p.chunks.set(Number(fields.segment_index) || 0, file);
			return new Response(null, { status: 204 });
		}
		case "FINALIZE": {
			const p = id ? pending.get(id) : undefined;
			if (!p || p.userId !== viewer.id) return uploadError("Unknown upload.", 404);
			return finalize(id!, p);
		}
		case "STATUS": {
			if (!isId(id)) return uploadError("Unknown upload.", 404);
			const [row] = await sql`select id from media where id = ${id}::bigint and user_id = ${viewer.id}::bigint`;
			if (!row) return uploadError("Unknown upload.", 404);
			return Response.json({ ...idFields(id), processing_info: { state: "succeeded", progress_percent: 100 } });
		}
	}
	return uploadError("Unknown command.");
}

const mimeCache = new Map<string, string>();

// /media/<id>[.ext] and /media/banner/<id>[/<size>]; the client asks for sizes
// through the query string or a path suffix, and gets the original either way
export async function serveMedia(pathname: string): Promise<Response> {
	const m = /^\/media\/(?:banner\/)?(\d{1,19})(?:\.[a-z]+)?(?:\/[\w-]+)?$/.exec(pathname);
	if (!m || !existsSync(fileOf(m[1]))) return new Response("not found", { status: 404 });
	let mime = mimeCache.get(m[1]);
	if (!mime) {
		const [row] = await sql`select mime from media where id = ${m[1]}::bigint`;
		if (!row) return new Response("not found", { status: 404 });
		mime = row.mime as string;
		mimeCache.set(m[1], mime);
	}
	return new Response(readFileSync(fileOf(m[1])), {
		headers: { "content-type": mime, "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff" },
	});
}

// attaches uploads to a new post; only the poster's own unused uploads count
export async function attachMedia(userId: string, postId: string, mediaIds: string[]) {
	for (const [i, id] of mediaIds.slice(0, 4).entries())
		await sql`update media set post_id = ${postId}::bigint, position = ${i}
			where id = ${id}::bigint and user_id = ${userId}::bigint and post_id is null`;
}

export async function mediaForPosts(postIds: string[]): Promise<Map<string, MediaRow[]>> {
	const out = new Map<string, MediaRow[]>();
	if (!postIds.length) return out;
	const rows = await sql`select id, post_id, kind, mime, size, width, height, position from media
		where post_id = any(${sql.array(postIds, "INT8")}) order by post_id, position`;
	for (const r of rows) {
		const list = out.get(r.post_id) ?? [];
		list.push(r as MediaRow);
		out.set(r.post_id, list);
	}
	return out;
}

function fit(w: number, h: number, max: number) {
	const scale = Math.min(1, max / Math.max(w, h));
	return { w: Math.round(w * scale), h: Math.round(h * scale), resize: "fit" };
}

// one photo as it appears in a post's entities.media and extended_entities.media
export function mediaEntity(m: MediaRow, postId: string, screenName: string, index: number, textLength: number) {
	const page = `${PUBLIC_ORIGIN}/${screenName}/status/${postId}/photo/${index + 1}`;
	return {
		allow_download_status: { allow_download: true },
		display_url: `pic.${PUBLIC_HOSTNAME}/${m.id}`,
		expanded_url: page,
		ext_media_availability: { status: "Available" },
		features: { large: { faces: [] }, medium: { faces: [] }, orig: { faces: [] }, small: { faces: [] } },
		id_str: m.id,
		// the link is not part of the text, so it takes no room in it
		indices: [textLength, textLength],
		media_key: `3_${m.id}`,
		media_results: { result: { media_key: `3_${m.id}` } },
		media_url_https: mediaUrl(m.id, m.mime),
		original_info: { focus_rects: [], height: m.height, width: m.width },
		sizes: {
			large: fit(m.width, m.height, 2048),
			medium: fit(m.width, m.height, 1200),
			small: fit(m.width, m.height, 680),
			thumb: { h: 150, w: 150, resize: "crop" },
		},
		type: "photo",
		url: page,
	};
}
