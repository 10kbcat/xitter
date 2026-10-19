// usage: bun scripts/test-visibility.ts

import { createUser } from "../src/auth";
import { sql } from "../src/db";
import { newId } from "../src/ids";

const origin = `http://localhost:${process.env.PORT ?? 3000}`;
const stamp = Date.now() % 1e7;
let failures = 0;
function check(label: string, ok: boolean, detail: unknown = "") {
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail === "" ? "" : `: ${JSON.stringify(detail)}`}`);
}

async function session(name: string) {
	const r = await fetch(`${origin}/login`, { method: "POST", body: new URLSearchParams({ username: name, password: "testpass123" }), redirect: "manual" });
	const cookies = r.headers.getSetCookie().map((c) => c.split(";")[0]);
	const csrf = cookies.find((c) => c.startsWith("ct0="))?.slice(4) ?? "";
	const headers = { cookie: cookies.join("; "), "x-csrf-token": csrf };
	return {
		gql: async (op: string, variables: object) =>
			(await fetch(`${origin}/i/api/graphql/q/${op}`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ variables }) })).json(),
		get: async (op: string, variables: object) =>
			(await fetch(`${origin}/i/api/graphql/q/${op}?variables=${encodeURIComponent(JSON.stringify(variables))}`, { headers })).json(),
		form: (path: string, body: Record<string, string>) => fetch(`${origin}/i/api${path}`, { method: "POST", headers, body: new URLSearchParams(body) }),
	};
}

const names = ["vp", "vf", "vs", "vb"].map((p) => `${p}${stamp}`);
const ids = await Promise.all(names.map((n) => createUser(n, n, "testpass123")));
const [locked, fan, stranger] = ids;
try {
	await sql`update users set protected = true where id = ${locked}::bigint`;
	await sql`insert into follows (follower_id, followee_id) values (${fan}::bigint, ${locked}::bigint)`;
	const secret = newId();
	await sql`insert into posts (id, user_id, text, conversation_id) values (${secret}::bigint, ${locked}::bigint, 'followers only', ${secret}::bigint)`;
	const [, f, s] = await Promise.all(names.map(session));

	const replyTo = async (who: Awaited<ReturnType<typeof session>>, id: string) =>
		(await who.gql("CreateTweet", { tweet_text: `re ${Date.now()}`, reply: { in_reply_to_tweet_id: id } })).data?.create_tweet?.tweet_results?.result?.rest_id as string | undefined;
	check("a stranger can't reply to a protected post", !(await replyTo(s, secret)));
	const fanReply = await replyTo(f, secret);
	check("a follower can", !!fanReply);
	const early = newId();
	await sql`insert into posts (id, user_id, text, reply_to_id, reply_to_user_id, conversation_id) values (${early}::bigint, ${stranger}::bigint, 'from before', ${secret}::bigint, ${locked}::bigint, ${secret}::bigint)`;
	check("analytics on a reply don't show a parent its author can't see", !JSON.stringify(await s.get("postDetailsProviderQuery", { rest_id: early })).includes("followers only"));
	if (fanReply) check("but show it to someone who can", JSON.stringify(await f.get("postDetailsProviderQuery", { rest_id: fanReply })).includes("followers only"));
} finally {
	await sql`delete from users where id = any(${sql.array(ids, "INT8")})`;
}
console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
