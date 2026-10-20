// OAuth client ID metadata documents (draft-ietf-oauth-client-id-metadata-document):
// an app can use the https URL of a JSON document it hosts as its client_id,
// instead of registering a client on every instance. The document names the
// app and lists its redirect URLs, so one app signs in on any Xitter in one tap.
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { PUBLIC_ORIGIN } from "./config";

export type ClientMetadata = { url: string; name: string; redirects: string[] };

const MAX_BYTES = 16 * 1024;
const TTL = 5 * 60_000, FAILED_TTL = 60_000;
const cache = new Map<string, { at: number; doc: ClientMetadata | undefined }>();

// a client_id that names a metadata document: https, a path, no query,
// fragment, credentials or port
export function metadataClientId(value: string): URL | undefined {
	if (!value.startsWith("https://") || value.length > 512) return undefined;
	try {
		const url = new URL(value);
		if (url.href !== value || url.search || url.hash || url.username || url.password || url.port || url.pathname === "/") return undefined;
		if (isIP(url.hostname.replace(/^\[|\]$/g, "")) || !url.hostname.includes(".") || /\.(local|localhost|internal|lan|home\.arpa)$/i.test(url.hostname)) return undefined;
		return url;
	} catch {
		return undefined;
	}
}

// loopback, private, link-local, carrier-grade NAT, multicast and reserved
// ranges: the server never fetches a client document from these
const RESERVED = new BlockList();
for (const [address, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 3]] as const)
	RESERVED.addSubnet(address, prefix, "ipv4");
// (BlockList matches every IPv4 address against ::ffff:0:0/96, so mapped
// addresses are unwrapped below rather than listed here)
for (const [address, prefix] of [["::", 127], ["64:ff9b::", 96], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]] as const)
	RESERVED.addSubnet(address, prefix, "ipv6");
const reserved = (address: string) => {
	const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
	if (mapped) return RESERVED.check(mapped, "ipv4");
	return /^::ffff:/i.test(address) || RESERVED.check(address, isIP(address) === 6 ? "ipv6" : "ipv4");
};

// tests swap the lookup out
export const resolver = { lookup: (host: string) => lookup(host, { all: true, verbatim: true }) };

async function publicHost(host: string): Promise<boolean> {
	try {
		const addresses = await resolver.lookup(host);
		return addresses.length > 0 && addresses.every((a) => isIP(a.address) && !reserved(a.address));
	} catch {
		return false;
	}
}

async function readCapped(res: Response): Promise<string | undefined> {
	if (Number(res.headers.get("content-length") ?? 0) > MAX_BYTES || !res.body) return undefined;
	const reader = res.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > MAX_BYTES) {
			await reader.cancel().catch(() => {});
			return undefined;
		}
		chunks.push(value);
	}
	return Buffer.concat(chunks).toString("utf8");
}

function parse(url: string, text: string): ClientMetadata | undefined {
	let doc: Record<string, unknown>;
	try {
		doc = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!doc || typeof doc !== "object" || doc.client_id !== url) return undefined;
	// public clients only: no secrets to hold, PKCE does the proving
	if (doc.token_endpoint_auth_method !== undefined && doc.token_endpoint_auth_method !== "none") return undefined;
	if (!Array.isArray(doc.redirect_uris) || !doc.redirect_uris.length || doc.redirect_uris.length > 10) return undefined;
	// redirects stay on the document's own host, so a document can't send
	// codes to a site it doesn't control
	const host = new URL(url).hostname;
	const redirects = doc.redirect_uris.filter((r): r is string => {
		if (typeof r !== "string" || !r.startsWith("https://") || r.length > 2048) return false;
		try {
			const u = new URL(r);
			return u.hostname === host && !u.hash && !u.username && !u.password;
		} catch {
			return false;
		}
	});
	if (!redirects.length) return undefined;
	const raw = typeof doc.client_name === "string" ? doc.client_name.replace(/\p{Cc}/gu, "").trim() : "";
	const name = raw && [...raw].length <= 80 ? raw : host;
	return { url, name, redirects };
}

// the app's metadata document, fetched (and kept five minutes, a failure one), or undefined
// when it can't be used
export async function clientMetadata(clientId: string): Promise<ClientMetadata | undefined> {
	const url = metadataClientId(clientId);
	if (!url) return undefined;
	const hit = cache.get(url.href);
	if (hit && Date.now() - hit.at < (hit.doc ? TTL : FAILED_TTL)) return hit.doc;
	let doc: ClientMetadata | undefined;
	if (await publicHost(url.hostname)) {
		try {
			const res = await fetch(url.href, { redirect: "manual", headers: { accept: "application/json" }, signal: AbortSignal.timeout(5000) });
			const text = res.status === 200 ? await readCapped(res) : undefined;
			doc = text === undefined ? undefined : parse(url.href, text);
		} catch {}
	}
	if (cache.size > 500) cache.clear();
	cache.set(url.href, { at: Date.now(), doc });
	return doc;
}

// RFC 8414 server metadata: tells apps where to send people, and that a
// metadata document URL works as a client_id here
export function authorizationServerMetadata(): Response {
	return Response.json(
		{
			issuer: PUBLIC_ORIGIN,
			authorization_endpoint: `${PUBLIC_ORIGIN}/oauth/authorize`,
			token_endpoint: `${PUBLIC_ORIGIN}/oauth/token`,
			response_types_supported: ["code"],
			grant_types_supported: ["authorization_code"],
			code_challenge_methods_supported: ["S256"],
			token_endpoint_auth_methods_supported: ["none"],
			scopes_supported: ["read", "write"],
			client_id_metadata_document_supported: true,
		},
		{ headers: { "access-control-allow-origin": "*", "cache-control": "public, max-age=3600" } },
	);
}
