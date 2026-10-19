// Profile decor from Steam: only gold-check accounts wear it, picks are checked
// against Steam, and the files come through /public/steam/.
// usage: bun scripts/test-decor.ts <gold account> <other account> <password>   (against a running server; needs Steam reachable)
import { sql } from "../src/db";

const origin = `http://localhost:${process.env.PORT ?? 3000}`;
const [goldName, otherName, password] = process.argv.slice(2);
if (!password) throw new Error("usage: bun scripts/test-decor.ts <gold account> <other account> <password>");

let failed = 0;
const check = (ok: boolean, label: string) => {
	if (!ok) failed++;
	console.log(`${ok ? "ok  " : "FAIL"} ${label}`);
};

async function signIn(name: string) {
	const r = await fetch(`${origin}/login`, { method: "POST", body: new URLSearchParams({ username: name, password }), redirect: "manual" });
	const cookies = r.headers.getSetCookie().map((c) => c.split(";")[0]);
	const csrf = cookies.find((c) => c.startsWith("ct0="))?.slice(4);
	if (!csrf) throw new Error(`login ${name} failed`);
	const cookie = cookies.join("; ");
	const page = await fetch(`${origin}/account/decor`, { headers: { cookie } }).then((r) => r.text());
	const formCsrf = /name="csrf" value="([^"]+)"/.exec(page)?.[1] ?? "";
	return {
		page,
		api: (path: string) => fetch(`${origin}/i/api${path}`, { headers: { cookie, "x-csrf-token": csrf } }),
		post: (fields: Record<string, string>) =>
			fetch(`${origin}/account/decor`, { method: "POST", headers: { cookie }, body: new URLSearchParams({ csrf: formCsrf, ...fields }), redirect: "manual" }),
	};
}

const [before] = await sql`select decor from users where lower(screen_name) = lower(${goldName})`;
try {
	const gold = await signIn(goldName);
	const other = await signIn(otherName);
	check(gold.page.includes("Steam items"), "a gold-check account gets the picker");
	check(!other.page.includes("Steam items"), "another account doesn't");

	const frames = await gold.api("/xitter/decor/shop?kind=frame").then((r) => r.json());
	check(frames.items?.length > 0, `the shop lists avatar frames (${frames.items?.length})`);
	const portal = await gold.api("/xitter/decor/shop?kind=background&q=portal%202").then((r) => r.json());
	check(portal.items?.length > 0 && portal.items.every((i: any) => i.appid === 620 || i.appid === 400), `searching a game finds its backgrounds (${portal.items?.length})`);
	const animated = await gold.api("/xitter/decor/shop?kind=background").then((r) => r.json());
	const moving = animated.items?.find((i: any) => i.movie);

	check((await other.post({ kind: "frame", defid: String(frames.items[0].defid) })).status === 400, "another account can't wear a frame");
	check((await gold.post({ kind: "frame", defid: String(portal.items[0].defid) })).status === 400, "a background can't go in the frame slot");
	check((await gold.post({ kind: "frame", defid: "abc" })).status === 400, "a made-up item is refused");
	check((await gold.post({ theme: "NotATheme" })).status === 400, "an unknown theme is refused");
	check((await gold.post({ kind: "frame", defid: String(frames.items[0].defid), csrf: "wrong" })).status === 400, "a form without the csrf token is refused");

	check((await gold.post({ kind: "frame", defid: String(frames.items[0].defid) })).status === 303, "a gold-check account wears a frame");
	check((await gold.post({ kind: "background", defid: String((moving ?? portal.items[0]).defid) })).status === 303, "and a background");
	check((await gold.post({ theme: "Cosmic" })).status === 303, "and a theme");

	const worn = await other.api(`/xitter/decor?names=${goldName},${otherName}`).then((r) => r.json());
	const mine = worn[goldName.toLowerCase()];
	check(!!mine?.frame && !!mine?.background?.image && mine?.theme?.id === "Cosmic", "others see all three");
	check(!worn[otherName.toLowerCase()], "an account without decor isn't listed");
	check(!moving || !!mine?.background?.movie, "an animated background comes with its video");

	const file = await fetch(`${origin}${mine.frame}`);
	check(file.ok && file.headers.get("content-type") === "image/png", `the frame comes from /public/steam (${file.status})`);
	if (mine.background.movie) {
		const part = await fetch(`${origin}${mine.background.movie}`, { headers: { range: "bytes=0-99" } });
		check(part.status === 206 && (await part.arrayBuffer()).byteLength === 100, `the video is served in pieces (${part.status})`);
	}
	check((await fetch(`${origin}/public/steam/620/..%2F..%2Fsecret.png`)).status === 404, "only Steam's own file names are served");
	// an item nobody wears isn't fetched for strangers, nor kept
	const unworn = frames.items.find((i: any) => i.defid !== frames.items[0].defid);
	check((await fetch(`${origin}${unworn.thumb}`)).status === 404, "a signed-out visitor can't fetch an item nobody wears");
	check((await gold.api(`/../../public/steam/${unworn.appid}/${unworn.image}`)).ok, "a signed-in account browsing the shop can");
	const video = animated.items?.find((i: any) => i.movie && i.defid !== moving?.defid);
	if (video) check((await gold.api(`/../../public/steam/${video.appid}/${video.movie}`)).status === 404, "but never a video nobody wears");

	// losing the gold check hides it, without forgetting it
	await sql`update users set verified_type = 'blue' where lower(screen_name) = lower(${goldName})`;
	const hidden = await other.api(`/xitter/decor?names=${goldName}`).then((r) => r.json());
	check(!hidden[goldName.toLowerCase()], "without the gold check nothing shows");
	await sql`update users set verified_type = 'business' where lower(screen_name) = lower(${goldName})`;

	for (const f of [{ kind: "frame", defid: "" }, { kind: "background", defid: "" }, { theme: "" }]) await gold.post(f);
	const [after] = await sql`select decor from users where lower(screen_name) = lower(${goldName})`;
	check(after.decor === null, "removing all three clears it");
} finally {
	await sql`update users set verified_type = 'business', decor = ${before?.decor ? JSON.stringify(before.decor) : null}::text::jsonb where lower(screen_name) = lower(${goldName})`;
}
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
