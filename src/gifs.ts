// GIF search through Tenor (v2). The browser may only talk to this origin, and a
// picked GIF is downloaded by the client and uploaded like any other media, so
// results point at /i/api/xitter/gif, which fetches from Tenor's hosts only.
// Needs TENOR_API_KEY; without one the composer's GIF button is hidden.

import type { Viewer } from "./auth";

const API = process.env.TENOR_API_URL ?? "https://tenor.googleapis.com/v2";
export const gifKey = () => process.env.TENOR_API_KEY ?? "";

type Vars = Record<string, any>;

const PROVIDER = { id: "tenor", display_name: "Tenor" };

// only Tenor's own media hosts are fetched on a user's behalf
export const gifHostAllowed = (host: string) => /(^|\.)tenor\.com$|(^|\.)tenor\.googleapis\.com$/.test(host) || host === new URL(API).host;

const proxied = (url: string) => `/i/api/xitter/gif?u=${encodeURIComponent(url)}`;

function image(format: any, still: string | undefined) {
	if (!format?.url) return null;
	const [width, height] = Array.isArray(format.dims) ? format.dims : [0, 0];
	return { url: proxied(format.url), width, height, still_image_url: proxied(still ?? format.url) };
}

function item(r: any) {
	const gif = r.media_formats?.gif ?? r.media_formats?.mediumgif;
	const tiny = r.media_formats?.tinygif ?? gif;
	const still = r.media_formats?.gifpreview?.url ?? tiny?.url;
	const full = image(gif, still);
	const thumb = image(tiny, still);
	if (!full || !thumb) return null;
	return {
		id: `tenor_${r.id}`,
		provider: PROVIDER,
		alt_text: r.content_description ?? r.title ?? "",
		full_image: full,
		preview_image: thumb,
		thumbnail_images: [thumb],
	};
}

async function tenor(path: string, params: Record<string, string>) {
	const key = gifKey();
	if (!key) return { results: [], next: "" };
	const url = new URL(`${API}${path}`);
	for (const [k, v] of Object.entries({ key, client_key: "xitter", media_filter: "gif,tinygif,gifpreview", contentfilter: "medium", ...params })) url.searchParams.set(k, v);
	const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
	if (!r.ok) throw new Error(`tenor ${r.status}`);
	return (await r.json()) as { results?: any[]; next?: string };
}

const slice = (data: { results?: any[]; next?: string }) => ({
	items: (data.results ?? []).map(item).filter(Boolean),
	slice_info: data.next ? { next_cursor: data.next } : {},
});

const count = (vars: Vars) => String(Math.min(Math.max(Number(vars.count) || 20, 1), 50));
const cursor = (vars: Vars) => (typeof vars.cursor === "string" && vars.cursor ? { pos: vars.cursor } : {});

export const gifHandlers = {
	GifSearch: async (_v: Viewer, vars: Vars) => {
		const q = String(vars.rawQuery ?? vars.raw_query ?? vars.query ?? vars.searchTerm ?? "").trim();
		if (!q) return { data: { gif_search_slice: { items: [], slice_info: {} } } };
		return { data: { gif_search_slice: slice(await tenor("/search", { q, limit: count(vars), ...cursor(vars) })) } };
	},
	GifEnumerateCategory: async (_v: Viewer, vars: Vars) => {
		const category = String(vars.category ?? vars.categoryName ?? "trending");
		const data =
			category === "trending"
				? await tenor("/featured", { limit: count(vars), ...cursor(vars) })
				: await tenor("/search", { q: category, limit: count(vars), ...cursor(vars) });
		return { data: { gif_enumerate_category_slice: slice(data) } };
	},
};

export async function gifProxy(url: URL): Promise<Response> {
	let target: URL;
	try {
		target = new URL(url.searchParams.get("u") ?? "");
	} catch {
		return new Response("bad url", { status: 400 });
	}
	if (!/^https?:$/.test(target.protocol) || !gifHostAllowed(target.host)) return new Response("not allowed", { status: 403 });
	const upstream = await fetch(target, { signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
	if (!upstream?.ok) return new Response("not found", { status: 404 });
	const type = upstream.headers.get("content-type") ?? "";
	if (!/^image\//.test(type)) return new Response("not an image", { status: 415 });
	return new Response(upstream.body, { headers: { "content-type": type, "cache-control": "private, max-age=86400" } });
}
