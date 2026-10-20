// Passkeys against a running server (PUBLIC_ORIGIN must be its address):
// adding one on /account/passkeys, signing in with it, a reused challenge, a
// copied authenticator, removing it. Makes its own account and removes it.
// usage: bun scripts/test-passkeys.ts

import { createUser } from "../src/auth";
import { PUBLIC_HOSTNAME, PUBLIC_ORIGIN } from "../src/config";
import { sql } from "../src/db";
import { b64url } from "../src/webauthn";
import { KINDS, authenticator } from "./fake-authenticator";

const origin = PUBLIC_ORIGIN;
const name = `p${Date.now() % 1e8}`;
let failures = 0;
function check(label: string, ok: boolean, detail: unknown = "") {
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail === "" ? "" : `: ${JSON.stringify(detail)}`}`);
}

const encode = (r: Record<string, Uint8Array | string>) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "string" ? v : b64url(v)]));
const post = (path: string, body: unknown, cookie = "") =>
	fetch(`${origin}${path}`, { method: "POST", headers: { "content-type": "application/json", origin, cookie }, body: JSON.stringify(body) });

const id = await createUser(name, "Pass Key", "testpass123");
try {
	const login = await fetch(`${origin}/login`, { method: "POST", body: new URLSearchParams({ username: name, password: "testpass123" }), redirect: "manual" });
	const cookies = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

	check("the page lists none", (await (await fetch(`${origin}/account/passkeys`, { headers: { cookie: cookies } })).text()).includes("haven't added any passkeys"));
	check("adding needs the password", (await post("/account/passkeys/options", { password: "wrong" }, cookies)).status === 400);
	check("another site can't ask", (await fetch(`${origin}/account/passkeys/options`, { method: "POST", headers: { origin: "https://evil.example", cookie: cookies }, body: "{}" })).status === 403);
	const options = await (await post("/account/passkeys/options", { password: "testpass123" }, cookies)).json();
	check("options name the site and account", options.rp?.id === PUBLIC_HOSTNAME && Buffer.from(options.user.id, "base64url").toString() === id, options.rp);

	const key = authenticator(KINDS.ES256!, { challenge: options.challenge, origin, rpId: PUBLIC_HOSTNAME });
	const added = await post("/account/passkeys/add", { ...encode(key.create()), name: "Test phone", transports: ["internal"] }, cookies);
	check("adds it", added.ok, await added.json());
	check("the challenge is used up", !(await post("/account/passkeys/add", encode(key.create()), cookies)).ok);
	check("the page lists it", (await (await fetch(`${origin}/account/passkeys`, { headers: { cookie: cookies } })).text()).includes("Test phone"));

	const signIn = async (count: number, over: Record<string, unknown> = {}) => {
		const o = await (await post("/account/passkey/options", {})).json();
		const r = key.get(count, 0x05, { challenge: o.challenge, ...over });
		return post("/account/passkey/signin", { id: key.id, ...encode(r), userHandle: b64url(new TextEncoder().encode(id)) });
	};
	const ok = await signIn(1);
	const set = ok.headers.getSetCookie().map((c) => c.split(";")[0]);
	check("signs in", ok.ok && set.some((c) => c.startsWith("auth_token=")), await ok.json());
	const me = await fetch(`${origin}/account/passkeys`, { headers: { cookie: set.join("; ") } });
	check("the new session works", (await me.text()).includes("Test phone"));
	check("a counter that didn't move is refused", (await signIn(1)).status === 403);
	check("a wrong origin is refused", (await signIn(5, { origin: "https://evil.example" })).status === 400);
	const o = await (await post("/account/passkey/options", {})).json();
	const once = { id: key.id, ...encode(key.get(9, 0x05, { challenge: o.challenge })) };
	check("signs in again", (await post("/account/passkey/signin", once)).ok);
	check("an answer can't be replayed", (await post("/account/passkey/signin", once)).status === 400);
	const [{ n }] = await sql`select count(*)::int as n from login_events where user_id = ${id}::bigint`;
	check("sign-ins are in the access history", n >= 3, n);

	await sql`update users set status = 'suspended' where id = ${id}::bigint`;
	check("a suspended account can't", (await signIn(20)).status === 403);
	await sql`update users set status = 'active' where id = ${id}::bigint`;

	await fetch(`${origin}/account/passkeys/remove`, { method: "POST", body: new URLSearchParams({ id: key.id }), headers: { cookie: cookies } });
	check("removes it", (await signIn(30)).status === 400);
} finally {
	await sql`delete from users where id = ${id}::bigint`;
	await sql.close();
}
if (failures) process.exit(1);
