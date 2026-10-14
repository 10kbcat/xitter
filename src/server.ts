import { type Viewer, getViewer } from "./auth";
import { getClientFile } from "./client-cache";
import { PORT, PUBLIC_ORIGIN } from "./config";
import { migrate } from "./db";
import { knownOperation, runOperation } from "./graphql";
import { brandingFile } from "./branding";
import { handleLogin, handleSignup, loginPage, rulesPage, signupPage } from "./login";
import { adminApi } from "./admin";
import { loadSettings } from "./settings";
import { flagPickerData } from "./flag-picker";
import { flagSvg } from "./flags";
import { patchFile } from "./patch";
import { MEDIA_DIR, mediaUpload, serveMedia } from "./media";
import { resumeVideos } from "./video";
import { livePipeline, restRoute } from "./rest";
import { shell } from "./shell";

const MIME: Record<string, string> = {
	js: "text/javascript; charset=utf-8",
	css: "text/css; charset=utf-8",
	json: "application/json",
	svg: "image/svg+xml",
	png: "image/png",
	jpg: "image/jpeg",
	ico: "image/x-icon",
	woff: "font/woff",
	woff2: "font/woff2",
};

// On its own domain the client prefixes API paths with /i/api; in its localhost
// dev mode it calls the bare paths.
// The client also calls outside services on its own (grok.com checkout, ads
// measurement). Requests from the page may only reach this instance.
const PAGE_CSP = "connect-src 'self' blob: data:";

// the instance's own files (logo, icons), open to everyone since the sign-in page uses them
const PUBLIC_DIR = process.env.PUBLIC_DIR ?? "public";
async function servePublic(p: string): Promise<Response> {
	const name = p.slice("/public/".length);
	const flag = /^flag-([a-z]+)\.svg$/.exec(name);
	if (flag) {
		const svg = flagSvg(flag[1]);
		return svg ? new Response(svg, { headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" } }) : new Response("not found", { status: 404 });
	}
	if (!/^[\w.-]+\.(png|svg|ico|webp)$/.test(name)) return new Response("not found", { status: 404 });
	// a logo uploaded in the admin panel replaces the shipped one
	const uploaded = brandingFile(name);
	if (uploaded && (await uploaded.file.exists())) return new Response(uploaded.file, { headers: { "content-type": uploaded.type, "cache-control": "no-cache" } });
	const file = Bun.file(`${PUBLIC_DIR}/${name}`);
	if (!(await file.exists())) return new Response("not found", { status: 404 });
	return new Response(file, { headers: { "cache-control": "no-cache" } });
}

const API_PREFIX = /^\/(i\/api\/|i\/jfapi\/|i\/media\/|1\.1\/|2\/|graphql\/|fleets\/|live_pipeline\/)/;
// calls no handler exists for yet, most frequent first
const unknown = new Map<string, number>();

const apiError = (status: number, code: number, message: string) => Response.json({ errors: [{ code, message }] }, { status });

const etags = new Map<string, string>();

async function serveClient(req: Request, pathname: string): Promise<Response> {
	const cdnPath = pathname.slice("/abs".length);
	const raw = await getClientFile(cdnPath);
	if (!raw) return new Response("not found", { status: 404 });
	const ext = cdnPath.split(".").pop() ?? "";
	const type = MIME[ext] ?? "application/octet-stream";
	if (ext !== "js" && ext !== "css")
		return new Response(new Uint8Array(raw), { headers: { "content-type": type, "cache-control": "public, max-age=31536000, immutable" } });

	// The file name stays the same when our patches change, so patched files are
	// revalidated against a hash of what we actually serve.
	const body = patchFile(cdnPath, raw);
	let etag = etags.get(cdnPath);
	if (!etag) {
		etag = `"${Bun.hash(body).toString(36)}"`;
		etags.set(cdnPath, etag);
	}
	if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { etag } });
	return new Response(new Uint8Array(body), { headers: { "content-type": type, "cache-control": "no-cache", etag } });
}

function parseJson(text: string | null): any {
	if (!text) return {};
	try {
		return JSON.parse(text) ?? {};
	} catch {
		return {};
	}
}

async function serveApi(req: Request, url: URL, viewer: Viewer | undefined): Promise<Response> {
	if (!viewer) return apiError(401, 32, "Could not authenticate you.");
	if (req.method !== "GET" && req.headers.get("x-csrf-token") !== viewer.csrf)
		return apiError(403, 353, "This request requires a matching csrf cookie and header.");

	const path = url.pathname.replace(/^\/i\/(jf)?api/, "");
	const parts = path.split("/").filter(Boolean);
	const gql = parts.indexOf("graphql");
	if (process.env.LOG_REQUESTS) console.log(`api ${req.method} ${gql >= 0 ? `graphql:${parts[parts.length - 1]}` : path}`);
	// the client reports its own render errors through telemetry
	if (process.env.LOG_REQUESTS === "errors" && req.method === "POST") {
		const body = decodeURIComponent(await req.clone().text()).replace(/\+/g, " ");
		for (const m of body.matchAll(/.{0,160}(?:[Ee]rror|exception|stack).{0,400}/g)) console.log(`client-report ${path}: ${m[0]}`);
	}
	if (/^\/(i|1\.1)\/media\/upload2?\.json$/.test(path)) return mediaUpload(req, url, viewer);
	if (gql >= 0) {
		const name = parts[parts.length - 1];
		if (knownOperation(name)) {
			const vars = req.method === "GET" ? parseJson(url.searchParams.get("variables")) : parseJson(await req.text()).variables;
			return runOperation(name, viewer, vars ?? {});
		}
	} else if (path === "/live_pipeline/events") {
		return livePipeline();
	}
	const rest = await restRoute(req.method, path, viewer, req);
	if (rest) return rest;

	const key = `${req.method} ${gql >= 0 ? `graphql:${parts[parts.length - 1]}` : path}`;
	unknown.set(key, (unknown.get(key) ?? 0) + 1);
	console.log(`unhandled ${key}`);
	return Response.json(gql >= 0 ? { data: {} } : {});
}

await migrate();
await loadSettings();
await resumeVideos(MEDIA_DIR);

const server = Bun.serve({
	port: PORT,
	async fetch(req) {
		const url = new URL(req.url);
		const p = url.pathname;
		if (p.startsWith("/abs/")) return serveClient(req, p);
		if (req.method === "OPTIONS") return new Response(null, { status: 204 });
		if (p === "/login") return req.method === "POST" ? handleLogin(req) : loginPage();
		if (p === "/rules") return rulesPage();
		if (p === "/signup") return req.method === "POST" ? handleSignup(req) : signupPage(url);
		if (p.startsWith("/public/")) return servePublic(p);
		if (p === "/favicon.ico") return servePublic("/public/favicon.png");
		if (p === "/sw.js" || p === "/manifest.json") return new Response(null, { status: 404 });

		const viewer = await getViewer(req);
		// uploads stay inside the instance: only signed-in users get them
		if (p.startsWith("/media/")) return viewer ? serveMedia(req, p) : new Response("not found", { status: 404 });
		// the admin panel: staff only; everyone else gets the client's not-found page
		if (p.startsWith("/admin/api/")) return adminApi(req, p.slice("/admin/api/".length), viewer);
		if (p === "/admin/flags.json" && viewer?.role) return Response.json(flagPickerData(null).flags);
		if ((p === "/admin" || p === "/admin/") && viewer?.role)
			return new Response(Bun.file(new URL("./admin.html", import.meta.url)), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
		if (p === "/_debug/unknown") return Response.json(Object.fromEntries([...unknown].sort((a, b) => b[1] - a[1])));
		if (API_PREFIX.test(p) || req.method !== "GET") {
			// the event stream must outlive the default idle timeout
			if (p.endsWith("/live_pipeline/events")) server.timeout(req, 0);
			return serveApi(req, url, viewer);
		}

		if (!viewer) return Response.redirect("/login", 302);
		const page = shell(viewer);
		if (!page) return new Response("no pinned client build: run scripts/fetch-client.ts --token or --har", { status: 500 });
		return new Response(page, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": PAGE_CSP } });
	},
	error(e) {
		console.error(e);
		return apiError(500, 131, "Internal error.");
	},
});

console.log(`xitter listening on ${PUBLIC_ORIGIN}`);
