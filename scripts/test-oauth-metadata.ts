// Client ID metadata documents: which URLs count, which documents are used,
// and that the server never fetches one from a private address.
import { afterEach, expect, test } from "bun:test";
import { authorizationServerMetadata, clientMetadata, metadataClientId, resolver } from "../src/oauth-metadata";

const realFetch = globalThis.fetch;
const realLookup = resolver.lookup;
afterEach(() => {
	globalThis.fetch = realFetch;
	resolver.lookup = realLookup;
});

let n = 0;
// a fresh URL per test, so the document cache never answers for another test
const fresh = () => `https://app.example/oauth-client-${++n}.json`;

function serve(body: unknown, init: ResponseInit = {}, address = "93.184.216.34") {
	const fetched: string[] = [];
	resolver.lookup = async () => [{ address, family: address.includes(":") ? 6 : 4 }];
	globalThis.fetch = (async (input: string | URL | Request) => {
		fetched.push(String(input instanceof Request ? input.url : input));
		return new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 200, ...init });
	}) as typeof fetch;
	return fetched;
}

test("only plain https document URLs are client IDs", () => {
	expect(metadataClientId("https://app.example/oauth-client.json")).toBeDefined();
	for (const bad of [
		"http://app.example/oauth-client.json",
		"https://app.example/",
		"https://app.example/c.json?x=1",
		"https://app.example/c.json#x",
		"https://user@app.example/c.json",
		"https://app.example:8443/c.json",
		"https://127.0.0.1/c.json",
		"https://[::1]/c.json",
		"https://localhost/c.json",
		"https://printer.local/c.json",
		"https://APP.example/c.json",
		"123456789",
	])
		expect(metadataClientId(bad)).toBeUndefined();
});

test("a valid document is used, with its redirects kept to its own host", async () => {
	const url = fresh();
	serve({ client_id: url, client_name: "xit mob", redirect_uris: ["https://app.example/", "https://evil.example/", "http://app.example/x"], token_endpoint_auth_method: "none" });
	expect(await clientMetadata(url)).toEqual({ url, name: "xit mob", redirects: ["https://app.example/"] });
});

test("the document is cached", async () => {
	const url = fresh();
	const fetched = serve({ client_id: url, client_name: "App", redirect_uris: ["https://app.example/"] });
	await clientMetadata(url);
	await clientMetadata(url);
	expect(fetched.length).toBe(1);
});

test("a missing or odd name falls back to the host", async () => {
	const url = fresh();
	serve({ client_id: url, client_name: "x".repeat(81), redirect_uris: ["https://app.example/"] });
	expect((await clientMetadata(url))?.name).toBe("app.example");
});

test("documents that don't describe themselves are refused", async () => {
	for (const doc of [
		(url: string) => ({ client_id: `${url}x`, redirect_uris: ["https://app.example/"] }),
		(url: string) => ({ client_id: url, redirect_uris: [] }),
		(url: string) => ({ client_id: url, redirect_uris: ["https://elsewhere.example/"] }),
		(url: string) => ({ client_id: url, redirect_uris: ["https://app.example/"], token_endpoint_auth_method: "client_secret_basic" }),
	]) {
		const url = fresh();
		serve(doc(url));
		expect(await clientMetadata(url)).toBeUndefined();
	}
	const url = fresh();
	serve("not json");
	expect(await clientMetadata(url)).toBeUndefined();
});

test("redirects, errors and oversized documents are refused", async () => {
	let url = fresh();
	serve("", { status: 302, headers: { location: "https://app.example/other.json" } });
	expect(await clientMetadata(url)).toBeUndefined();
	url = fresh();
	serve({ client_id: url, redirect_uris: ["https://app.example/"] }, { status: 404 });
	expect(await clientMetadata(url)).toBeUndefined();
	url = fresh();
	serve({ client_id: url, redirect_uris: ["https://app.example/"], pad: "x".repeat(20_000) });
	expect(await clientMetadata(url)).toBeUndefined();
});

test("hosts that resolve to private addresses are never fetched", async () => {
	for (const address of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:7f00:1"]) {
		const url = fresh();
		const fetched = serve({ client_id: url, redirect_uris: ["https://app.example/"] }, {}, address);
		expect(await clientMetadata(url)).toBeUndefined();
		expect(fetched.length).toBe(0);
	}
});

test("public IPv6 hosts are fetched", async () => {
	const url = fresh();
	serve({ client_id: url, redirect_uris: ["https://app.example/"] }, {}, "2606:4700::1111");
	expect((await clientMetadata(url))?.redirects).toEqual(["https://app.example/"]);
});

test("the server metadata says documents work as client IDs", async () => {
	const res = authorizationServerMetadata();
	expect(res.headers.get("access-control-allow-origin")).toBe("*");
	const body = await res.json();
	expect(body.client_id_metadata_document_supported).toBe(true);
	expect(body.code_challenge_methods_supported).toEqual(["S256"]);
	expect(body.authorization_endpoint).toEndWith("/oauth/authorize");
});
