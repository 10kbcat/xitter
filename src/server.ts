import { type Viewer, getViewer } from "./auth";
import { getClientFile } from "./client-cache";
import { PORT, PUBLIC_ORIGIN } from "./config";
import { migrate } from "./db";
import { knownOperation, runOperation } from "./graphql";
import { handleLogin, loginPage } from "./login";
import { patchFile } from "./patch";
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
const API_PREFIX = /^\/(i\/api\/|i\/jfapi\/|1\.1\/|2\/|graphql\/|fleets\/|live_pipeline\/)/;
// calls no handler exists for yet, most frequent first
const unknown = new Map<string, number>();

const apiError = (status: number, code: number, message: string) => Response.json({ errors: [{ code, message }] }, { status });

async function serveClient(pathname: string): Promise<Response> {
	const cdnPath = pathname.slice("/abs".length);
	const raw = await getClientFile(cdnPath);
	if (!raw) return new Response("not found", { status: 404 });
	const ext = cdnPath.split(".").pop() ?? "";
	const body = ext === "js" || ext === "css" ? patchFile(cdnPath, raw) : raw;
	return new Response(new Uint8Array(body), {
		headers: { "content-type": MIME[ext] ?? "application/octet-stream", "cache-control": "public, max-age=31536000, immutable" },
	});
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

const server = Bun.serve({
	port: PORT,
	async fetch(req) {
		const url = new URL(req.url);
		const p = url.pathname;
		if (p.startsWith("/abs/")) return serveClient(p);
		if (req.method === "OPTIONS") return new Response(null, { status: 204 });
		if (p === "/login") return req.method === "POST" ? handleLogin(req) : loginPage();
		if (p === "/sw.js" || p === "/favicon.ico" || p === "/manifest.json") return new Response(null, { status: 404 });

		const viewer = await getViewer(req);
		if (p === "/_debug/unknown") return Response.json(Object.fromEntries([...unknown].sort((a, b) => b[1] - a[1])));
		if (API_PREFIX.test(p) || req.method !== "GET") {
			// the event stream must outlive the default idle timeout
			if (p.endsWith("/live_pipeline/events")) server.timeout(req, 0);
			return serveApi(req, url, viewer);
		}

		if (!viewer) return Response.redirect("/login", 302);
		const page = shell(viewer);
		if (!page) return new Response("client page template is missing: run har:extract", { status: 500 });
		return new Response(page, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
	},
	error(e) {
		console.error(e);
		return apiError(500, 131, "Internal error.");
	},
});

console.log(`xitter listening on ${PUBLIC_ORIGIN}`);
