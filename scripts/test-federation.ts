// usage: bun scripts/test-federation.ts

import { SQL } from "bun";
import { newId } from "../src/ids";

const A = { origin: process.env.FED_A ?? "http://localhost:3041", db: new SQL(process.env.FED_A_DB ?? "postgres://tiago@127.0.0.1:5432/fed_a") };
const B = { origin: process.env.FED_B ?? "http://localhost:3042", db: new SQL(process.env.FED_B_DB ?? "postgres://tiago@127.0.0.1:5432/fed_b") };
const idOf = (origin: string) => new URL(origin).host;
const stamp = Date.now().toString(36).slice(-6);
let failures = 0;
function check(label: string, ok: boolean, detail: unknown = "") {
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail === "" ? "" : `: ${JSON.stringify(detail)}`}`);
}
async function until<T>(get: () => Promise<T>, seconds = 40): Promise<T | undefined> {
	for (let i = 0; i < seconds * 2; i++) {
		const v = await get().catch(() => undefined);
		if (v) return v;
		await Bun.sleep(500);
	}
	return undefined;
}

async function account(side: typeof A, name: string) {
	const id = newId();
	await side.db`insert into users (id, screen_name, name, password_hash) values (${id}::bigint, ${name}, ${name}, ${await Bun.password.hash("testpass123")})`;
	const r = await fetch(`${side.origin}/login`, { method: "POST", body: new URLSearchParams({ username: name, password: "testpass123" }), redirect: "manual" });
	const cookies = r.headers.getSetCookie().map((c) => c.split(";")[0]);
	const headers = { cookie: cookies.join("; "), "x-csrf-token": cookies.find((c) => c.startsWith("ct0="))?.slice(4) ?? "" };
	return {
		id,
		name,
		gql: async (op: string, variables: object) =>
			(await fetch(`${side.origin}/i/api/graphql/q/${op}`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ variables }) })).json(),
		get: async (op: string, variables: object) =>
			(await fetch(`${side.origin}/i/api/graphql/q/${op}?variables=${encodeURIComponent(JSON.stringify(variables))}`, { headers })).json(),
		form: (path: string, body: Record<string, string>) => fetch(`${side.origin}/i/api${path}`, { method: "POST", headers, body: new URLSearchParams(body) }),
		raw: (path: string) => fetch(`${side.origin}${path}`, { headers }),
	};
}

const made: { side: typeof A; id: string }[] = [];
try {
	const alice = await account(A, `fa${stamp}`);
	const bob = await account(B, `fb${stamp}`);
	made.push({ side: A, id: alice.id }, { side: B, id: bob.id });

	const posted = await alice.gql("CreateTweet", { tweet_text: `hello from a ${stamp}` });
	const postId = posted.data?.create_tweet?.tweet_results?.result?.rest_id as string;
	check("alice posts on A", !!postId);

	const aliceOnB = await until(async () => (await B.db`select id::text from users where instance = ${idOf(A.origin)} and remote_id = ${alice.id}::bigint`)[0]?.id as string);
	check("B keeps a copy of alice", !!aliceOnB);
	const [handle] = aliceOnB ? await B.db`select screen_name from users where id = ${aliceOnB}::bigint` : [];
	check("named with her instance", handle?.screen_name === `${alice.name}@${idOf(A.origin)}`, handle?.screen_name);
	const mirror = await until(async () => (await B.db`select local_id::text from federated_objects where instance = ${idOf(A.origin)} and kind = 'post' and remote_id = ${postId}::bigint`)[0]?.local_id as string);
	check("and her post", !!mirror);

	const found = await bob.get("UserByScreenName", { screen_name: `${alice.name}@${idOf(A.origin)}`, withSafetyModeUserFields: true });
	check("bob finds alice by her handle", found.data?.user?.result?.rest_id === aliceOnB, found.data?.user?.result?.rest_id);

	await bob.form("/1.1/friendships/create.json", { user_id: aliceOnB ?? "" });
	const bobOnA = await until(async () => (await A.db`select id::text from users where instance = ${idOf(B.origin)} and remote_id = ${bob.id}::bigint`)[0]?.id as string);
	check("A learns about bob", !!bobOnA);
	check(
		"A sees bob follow alice",
		!!(await until(async () => (await A.db`select 1 from follows where follower_id = ${bobOnA ?? "0"}::bigint and followee_id = ${alice.id}::bigint`).length > 0)),
	);

	await bob.gql("FavoriteTweet", { tweet_id: mirror });
	check("A sees bob's like", !!(await until(async () => (await A.db`select 1 from likes where user_id = ${bobOnA ?? "0"}::bigint and post_id = ${postId}::bigint`).length > 0)));

	const reply = await bob.gql("CreateTweet", { tweet_text: `hi alice ${stamp}`, reply: { in_reply_to_tweet_id: mirror } });
	const replyId = reply.data?.create_tweet?.tweet_results?.result?.rest_id as string;
	check("bob replies on B", !!replyId, reply.errors);
	const replyOnA = await until(async () => (await A.db`select local_id::text from federated_objects where instance = ${idOf(B.origin)} and kind = 'post' and remote_id = ${replyId}::bigint`)[0]?.local_id as string);
	const [threaded] = replyOnA ? await A.db`select reply_to_id::text, reply_to_user_id::text from posts where id = ${replyOnA}::bigint` : [];
	check("A threads bob's reply under alice's post", threaded?.reply_to_id === postId && threaded?.reply_to_user_id === alice.id, threaded);

	const mediaId = newId();
	const picture = Buffer.from(`GIF89a-${stamp}`);
	const picturePost = newId();
	await Bun.write(`${process.env.FED_A_MEDIA}/${mediaId}`, picture);
	await A.db.begin(async (tx) => {
		await tx`insert into posts (id, user_id, text, conversation_id) values (${picturePost}::bigint, ${alice.id}::bigint, 'a picture', ${picturePost}::bigint)`;
		await tx`insert into media (id, user_id, kind, mime, size, width, height, post_id, position) values (${mediaId}::bigint, ${alice.id}::bigint, 'photo', 'image/gif', ${picture.length}, 1, 1, ${picturePost}::bigint, 0)`;
		await tx`update posts set text = 'a picture!' where id = ${picturePost}::bigint`;
	});
	const pictureOnB = await until(async () => (await B.db`select m.id::text from media m join federated_objects f on f.kind = 'post' and f.local_id = m.post_id where f.remote_id = ${picturePost}::bigint`)[0]?.id as string);
	check("B lists the picture", !!pictureOnB);
	const served = pictureOnB ? await bob.raw(`/media/${pictureOnB}.gif`) : undefined;
	check("and serves it from its own address", served?.status === 200 && Buffer.from(await served.arrayBuffer()).equals(picture), served?.status);

	await alice.gql("DeleteTweet", { tweet_id: postId });
	check("a deleted post goes from B", !!(await until(async () => !(await B.db`select 1 from posts where id = ${mirror ?? "0"}::bigint`).length)));

	await A.db`update users set protected = true where id = ${alice.id}::bigint`;
	check("a protected account's posts go from B", !!(await until(async () => !(await B.db`select 1 from posts where user_id = ${aliceOnB ?? "0"}::bigint`).length)));

	const forged = await fetch(`${A.origin}/federation/v1/events?after=0`, {
		headers: { "x-xitter-from": idOf(B.origin), "x-xitter-to": idOf(A.origin), "x-xitter-timestamp": String(Date.now()), "x-xitter-nonce": "AAAAAAAAAAAAAAAAAAAAAA", "x-xitter-signature": "x".repeat(86) },
	});
	check("an unsigned request is refused", forged.status === 401, forged.status);
	const stranger = await fetch(`${A.origin}/federation/v1/events?after=0`, {
		headers: { "x-xitter-from": "evil.example", "x-xitter-to": idOf(A.origin), "x-xitter-timestamp": String(Date.now()), "x-xitter-nonce": "AAAAAAAAAAAAAAAAAAAAAA", "x-xitter-signature": "x".repeat(86) },
	});
	check("an instance off the list is refused", stranger.status === 403, stranger.status);
	const login = await fetch(`${A.origin}/login`, { method: "POST", body: new URLSearchParams({ username: `${bob.name}@${idOf(B.origin)}`, password: "!" }), redirect: "manual" });
	check("nobody signs in as a copied account", !login.headers.getSetCookie().some((c) => c.startsWith("auth_token=")));
} finally {
	for (const m of made) await m.side.db`delete from users where id = ${m.id}::bigint`;
}
console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
