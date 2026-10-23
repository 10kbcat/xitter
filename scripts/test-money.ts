// End-to-end check of X Money (/account/money) against a running server:
// starting balance, sending, the note, refusals, double-pressed Send, blocks,
// admins adjusting a balance and the side bar entry. Makes its own accounts and
// removes them.
// usage: bun scripts/test-money.ts

import { sql } from "../src/db";
import { createUser } from "../src/auth";
import { parseAmount, formatCents } from "../src/money";

const origin = `http://localhost:${process.env.PORT ?? 3000}`;
const stamp = Date.now() % 1e8;
const [a, b, c] = [`m${stamp}a`, `m${stamp}b`, `m${stamp}c`];
let failures = 0;
function check(label: string, ok: boolean, detail: unknown = "") {
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail === "" ? "" : `: ${JSON.stringify(detail)}`}`);
}

async function signIn(username: string) {
	const r = await fetch(`${origin}/login`, { method: "POST", body: new URLSearchParams({ username, password: "testpass123" }), redirect: "manual" });
	const cookie = r.headers.getSetCookie().map((x) => x.split(";")[0]).join("; ");
	const csrf = cookie.match(/ct0=([^;]+)/)?.[1] ?? "";
	const headers = { cookie, "sec-fetch-site": "same-origin" };
	const api = { ...headers, "x-csrf-token": csrf };
	const gql = async (op: string, variables: object) =>
		(await fetch(`${origin}/i/api/graphql/q/${op}`, { method: "POST", headers: { ...api, "content-type": "application/json" }, body: JSON.stringify({ variables }) })).json();
	const get = async (op: string, variables: object) =>
		(await fetch(`${origin}/i/api/graphql/q/${op}?variables=${encodeURIComponent(JSON.stringify(variables))}`, { headers: api })).json();
	const json = async (path: string) => (await fetch(`${origin}/i/api/xitter/${path}`, { headers: api })).json();
	const page = async (query = "") => (await fetch(`${origin}/account/money${query}`, { headers })).text();
	const send = (body: Record<string, string>) =>
		fetch(`${origin}/account/money`, { method: "POST", headers, body: new URLSearchParams({ idem: crypto.randomUUID(), ...body }), redirect: "manual" });
	return { headers, page, send, gql, get, json };
}
const balance = async (name: string) => {
	const [w] = await sql`select w.balance_cents from money_wallets w join users u on u.id = w.user_id where u.screen_name = ${name}`;
	return w ? Number(w.balance_cents) : null;
};

check("amounts parse", parseAmount("$12.5") === 1250 && parseAmount("3.52") === 352 && parseAmount("100") === 10000 && parseAmount("1,000") === 100000);
check("bad amounts don't", parseAmount("abc") === null && parseAmount("1.234") === null && parseAmount("-5") === null && parseAmount("") === null);
check("cents format", formatCents(352) === "$3.52" && formatCents(123456) === "$1,234.56");

const ids = [await createUser(a, "Money A", "testpass123"), await createUser(b, "Money B", "testpass123"), await createUser(c, "Money C", "testpass123")];
try {
	const sa = await signIn(a);
	const sb = await signIn(b);
	const first = await sa.page();
	check("the page shows the starting balance", first.includes("$100.00"));
	const form = await sa.page("/send");
	check("with a send screen", first.includes('href="/account/money/send"') && form.includes('name="amount"') && form.includes('name="idem"'));

	let r = await sa.send({ to: `@${b}`, amount: "12.50", note: "i miss you" });
	check("sending redirects back to the page", r.status === 303 && (r.headers.get("location") ?? "").startsWith("/account/money?sent="), r.status);
	check("the sender is charged", (await balance(a)) === 8750);
	check("the recipient is paid", (await balance(b)) === 11250);
	const after = await sa.page(new URL(r.headers.get("location")!, origin).search);
	check("the sender sees a confirmation", after.includes(`Sent $12.50 to @${b}`));
	check("and the payment in Activity", after.includes("−$12.50") && after.includes("i miss you"));
	const payId = new URL(r.headers.get("location")!, origin).searchParams.get("sent")!;
	const theirs = await sb.page();
	check("the recipient sees it too", theirs.includes("+$12.50") && theirs.includes("i miss you"));

	const receipt = await sa.page(`/p/${payId}`);
	check("the payment has its own page", receipt.includes("Completed") && receipt.includes("data-compose"));
	const sc = await signIn(c);
	check("a stranger can't see an unshared payment", (await fetch(`${origin}/account/money/p/${payId}`, { headers: sc.headers })).status === 404);
	check("nor its card", !(payId in (await sc.json(`money/cards?ids=${payId}`))));
	const recent = await sa.json("money/recent");
	check("the composer lists the payment", recent[0]?.id === payId && recent[0].url.endsWith(`/i/xmoney/p/${payId}`), recent[0]);
	const made = await sa.gql("CreateTweet", { tweet_text: `Fast & Free Payments ${recent[0].url}` });
	const post = made.data.create_tweet.tweet_results.result;
	check("a post with the payment's link gets its card", post.card?.legacy?.name === "summary" && JSON.stringify(post.card).includes(`$12.50 sent to Money B`), post.card?.legacy?.binding_values?.[0]);
	check("a stranger now sees the card", typeof (await sc.json(`money/cards?ids=${payId}&by=${a}`))[payId] === "string");
	const html = (await sb.json(`money/cards?ids=${payId}&by=${a}`))[payId] as string;
	check("the card reads as X's", html.includes("$12.50") && html.includes("sent to") && html.includes("i miss you"));
	check("its page opens for them too", (await fetch(`${origin}/account/money/p/${payId}`, { headers: sc.headers })).status === 200);
	const copied = await sc.gql("CreateTweet", { tweet_text: `look ${recent[0].url}` });
	check("someone else's post with the link gets no card", !copied.data.create_tweet.tweet_results.result.card);
	const notes = JSON.stringify(await sb.get("NotificationsTimeline", { timeline_type: "All", count: 40 }));
	check("the recipient is notified", notes.includes("sent you $12.50") && notes.includes(`/i/xmoney/p/${payId}`));
	const idem = crypto.randomUUID();
	await sa.send({ to: b, amount: "1", idem });
	await sa.send({ to: b, amount: "1", idem });
	check("a double-pressed Send moves the money once", (await balance(a)) === 8650);

	check("too much is refused", (await sa.send({ to: b, amount: "5000" })).status === 400);
	check("more than the balance is refused", (await sa.send({ to: b, amount: "999" })).status === 400 && (await balance(a)) === 8650);
	check("zero is refused", (await sa.send({ to: b, amount: "0" })).status === 400);
	check("yourself is refused", (await sa.send({ to: a, amount: "1" })).status === 400);
	check("an unknown account is refused", (await sa.send({ to: "nobody_here_x", amount: "1" })).status === 400);
	check("a long note is refused", (await sa.send({ to: b, amount: "1", note: "x".repeat(141) })).status === 400);

	await sql`delete from posts where user_id = any(${sql.array(ids, "INT8")})`;
	await sql`insert into blocks (blocker_id, blocked_id) values (${ids[2]}::bigint, ${ids[0]}::bigint)`;
	check("a blocked account is refused", (await sa.send({ to: c, amount: "1" })).status === 400);

	// ten $20 sends at once from $113.50: five go through, none overdraws
	await Promise.all(Array.from({ length: 10 }, () => sb.send({ to: a, amount: "20" })));
	check("concurrent sends never overdraw", (await balance(b))! >= 0 && (await balance(b))! + (await balance(a))! === 8650 + 11350 && (await balance(b)) === 1350, [await balance(a), await balance(b)]);

	check("a non-admin can't adjust", (await sb.send({ action: "adjust", to: a, amount: "50" })).status === 403);
	await sql`update users set role = 'admin' where id = ${ids[0]}::bigint`;
	const before = (await balance(b))!;
	r = await sa.send({ action: "adjust", to: b, amount: "50" });
	check("an admin adds money", r.status === 200 && (await balance(b)) === before + 5000);
	await sa.send({ action: "adjust", to: b, amount: "-100000" });
	check("and takes it away, never below zero", (await balance(b)) === 0);

	const shell = await fetch(`${origin}/account/money`, { headers: { ...sa.headers, "sec-fetch-dest": "document" }, redirect: "manual" });
	check("opened on its own, it goes to the client's page", shell.status === 302 && shell.headers.get("location") === "/i/xmoney", shell.headers.get("location"));
	check("signed out it isn't there", (await fetch(`${origin}/account/money`, { redirect: "manual" })).status === 302);
} finally {
	for (const id of ids) {
		await sql`delete from audit_log where target = ${id}`;
		await sql`delete from users where id = ${id}::bigint`;
	}
	await sql.close();
}
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
