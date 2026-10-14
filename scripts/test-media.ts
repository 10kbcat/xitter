// End-to-end check of uploads, photo posts and profile edits against a running
// server, the way the client calls them.
// usage: bun scripts/test-media.ts <user> <password> <image> [banner image]

import { readFileSync } from "node:fs";

const origin = `http://localhost:${process.env.PORT ?? 3000}`;
const [user, password, imagePath, bannerPath] = process.argv.slice(2);
if (!user || !password || !imagePath) throw new Error("usage: bun scripts/test-media.ts <user> <password> <image> [banner image]");

const login = await fetch(`${origin}/login`, { method: "POST", body: new URLSearchParams({ username: user, password }), redirect: "manual" });
const cookies = login.headers.getSetCookie().map((c) => c.split(";")[0]);
const csrf = cookies.find((c) => c.startsWith("ct0="))?.slice(4);
if (!csrf) throw new Error(`login failed (${login.status})`);
const headers = { cookie: cookies.join("; "), "x-csrf-token": csrf };

let failures = 0;
function check(label: string, ok: boolean, detail: unknown = "") {
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail === "" ? "" : `: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
}

async function upload(path: string, category: string, chunks = 2): Promise<string> {
	const data = readFileSync(path);
	const type = path.endsWith(".png") ? "image/png" : path.endsWith(".gif") ? "image/gif" : "image/jpeg";
	const init = await fetch(`${origin}/i/media/upload.json?command=INIT&total_bytes=${data.length}&media_type=${type}&media_category=${category}`, {
		method: "POST",
		headers,
	});
	const { media_id_string: id } = await init.json();
	const size = Math.ceil(data.length / chunks);
	for (let i = 0; i < chunks; i++) {
		const form = new FormData();
		form.set("media", new Blob([data.subarray(i * size, (i + 1) * size)]));
		const r = await fetch(`${origin}/i/media/upload.json?command=APPEND&media_id=${id}&segment_index=${i}`, { method: "POST", headers, body: form });
		if (r.status !== 204) throw new Error(`APPEND ${i}: ${r.status} ${await r.text()}`);
	}
	const fin = await (await fetch(`${origin}/i/media/upload.json?command=FINALIZE&media_id=${id}`, { method: "POST", headers })).json();
	check(`upload ${path} (${category})`, fin.media_id_string === id && fin.image?.w > 0, fin.image);
	return id;
}

const gql = async (op: string, variables: object) =>
	(await fetch(`${origin}/i/api/graphql/q/${op}`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ variables }) })).json();

const photo = await upload(imagePath, "tweet_image");
const created = await gql("CreateTweet", { tweet_text: "", media: { media_entities: [{ media_id: photo, tagged_users: [] }], possibly_sensitive: false } });
const post = created.data?.create_tweet?.tweet_results?.result;
const media = post?.legacy?.extended_entities?.media?.[0];
check("photo-only post", media?.id_str === photo, { type: media?.type, size: media?.original_info, url: media?.media_url_https });

const file = await fetch(media.media_url_https, { headers });
check("photo is served to a signed-in user", file.status === 200 && !!file.headers.get("content-type")?.startsWith("image/"), `${file.status} ${file.headers.get("content-type")}`);
check("photo is hidden from visitors", (await fetch(media.media_url_https)).status === 404);
const stolen = await gql("CreateTweet", { tweet_text: "reuse", media: { media_entities: [{ media_id: photo }] } });
check("an upload cannot be attached twice", !stolen.data?.create_tweet?.tweet_results?.result?.legacy?.extended_entities);

const avatar = await upload(imagePath, "profile_image", 1);
const a = await (await fetch(`${origin}/i/api/1.1/account/update_profile_image.json`, { method: "POST", headers, body: new URLSearchParams({ media_id: avatar, return_user: "true" }) })).json();
check("avatar set", String(a.profile_image_url_https).includes(avatar), a.profile_image_url_https);
if (bannerPath) {
	const banner = await upload(bannerPath, "banner_image", 3);
	const b = await (await fetch(`${origin}/i/api/1.1/account/update_profile_banner.json`, { method: "POST", headers, body: new URLSearchParams({ media_id: banner }) })).json();
	check("banner set", String(b.profile_banner_url).includes(banner), b.profile_banner_url);
	check("banner answers with a size suffix", (await fetch(`${b.profile_banner_url}/1500x500`, { headers })).status === 200);
}
const p = await (await fetch(`${origin}/i/api/1.1/account/update_profile.json`, {
	method: "POST",
	headers,
	body: new URLSearchParams({ description: "testing xitter", location: "Kyiv", url: "https://example.org" }),
})).json();
check("profile text updated", p.description === "testing xitter" && p.location === "Kyiv" && p.url === "https://example.org", { description: p.description, location: p.location, url: p.url });
const tooLong = await fetch(`${origin}/i/api/1.1/account/update_profile.json`, { method: "POST", headers, body: new URLSearchParams({ description: "x".repeat(161) }) });
check("161-character bio is refused", tooLong.status === 403);
const notImage = await fetch(`${origin}/i/media/upload.json?command=INIT&total_bytes=10&media_type=video/mp4&media_category=tweet_video`, { method: "POST", headers });
check("video is refused for now", notImage.status === 400);

console.log(failures ? `${failures} check(s) failed` : "all checks passed");
process.exit(failures ? 1 : 0);
