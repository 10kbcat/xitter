// End-to-end check of the admin panel's API and what its actions do to the
// rest of the site, against a running server. Needs an admin, a plain account
// (the target) and an organisation (gold badge), all with the same password;
// puts everything back afterwards.
// usage: bun scripts/test-admin.ts <admin> <target> <organisation> <password>

import { sql } from "../src/db";

const origin = `http://localhost:${process.env.PORT ?? 3000}`;
const [adminName, targetName, orgName, password] = process.argv.slice(2);
if (!adminName || !targetName || !orgName || !password) throw new Error("usage: bun scripts/test-admin.ts <admin> <target> <organisation> <password>");

async function session(username: string, pw = password) {
	const r = await fetch(`${origin}/login`, { method: "POST", body: new URLSearchParams({ username, password: pw }), redirect: "manual" });
	const cookies = r.headers.getSetCookie().map((c) => c.split(";")[0]);
	const csrf = cookies.find((c) => c.startsWith("ct0="))?.slice(4);
	if (!csrf) return undefined;
	const headers = { cookie: cookies.join("; "), "x-csrf-token": csrf };
	const admin = async (action: string, body: object = {}) => {
		const res = await fetch(`${origin}/admin/api/${action}`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });
		return { status: res.status, ...(await res.json()) };
	};
	const gql = async (op: string, variables: object) =>
		(await fetch(`${origin}/i/api/graphql/q/${op}`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ variables }) })).json();
	const get = async (op: string, variables: object) =>
		(await fetch(`${origin}/i/api/graphql/q/${op}?variables=${encodeURIComponent(JSON.stringify(variables))}`, { headers })).json();
	const page = async (path: string) => fetch(`${origin}${path}`, { headers, redirect: "manual" });
	return { admin, gql, get, page };
}

let failures = 0;
function check(label: string, ok: boolean, detail: unknown = "") {
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail === "" ? "" : `: ${JSON.stringify(detail)}`}`);
}

const entriesOf = (timeline: any): any[] => (timeline?.instructions ?? []).flatMap((i: any) => i.entries ?? []);
const postIds = (timeline: any) => entriesOf(timeline).map((e) => e.content?.itemContent?.tweet_results?.result?.rest_id).filter(Boolean);
const userIds = (timeline: any) => entriesOf(timeline).map((e) => e.content?.itemContent?.user_results?.result?.rest_id).filter(Boolean);

const a = (await session(adminName))!;
let t = (await session(targetName))!;
const o = (await session(orgName))!;
const [target] = await sql`select id::text as id, role, status from users where lower(screen_name) = lower(${targetName})`;
const [org] = await sql`select id::text as id from users where lower(screen_name) = lower(${orgName})`;

// access
check("the panel opens for staff", (await a.page("/admin")).status === 200);
check("and not for others", !(await (await t.page("/admin")).text()).includes("Admin · Xitter") && (await t.admin("stats")).status === 403);
check("the API wants the csrf header", (await fetch(`${origin}/admin/api/stats`, { method: "POST" })).status === 403);
const stats = await a.admin("stats");
check("stats come back", typeof stats.users === "number" && stats.days?.length === 14, stats.users);
check("the user list finds the target", (await a.admin("users", { q: targetName })).users?.some((u: any) => u.id === target.id));

// roles: a moderator can't do admin things or act on an admin
await a.admin("setRole", { id: target.id, role: "moderator" });
t = (await session(targetName))!;
check("a moderator can open the panel", (await t.admin("me")).role === "moderator");
check("but can't edit profiles", (await t.admin("updateUser", { id: org.id, name: "x" })).status === 403);
const [adminRow] = await sql`select id::text as id from users where lower(screen_name) = lower(${adminName})`;
check("or suspend an admin", (await t.admin("setStatus", { id: adminRow.id, status: "suspended" })).status === 403);
await a.admin("setRole", { id: target.id, role: target.role });
check("the last admin can't step down", (await a.admin("setRole", { id: adminRow.id, role: null })).status === 400);

// standing
const post = (await t.gql("CreateTweet", { tweet_text: "admin test: before" })).data.create_tweet.tweet_results.result.rest_id;
await a.admin("setStatus", { id: target.id, status: "restricted", reason: "test" });
check("restricted: can't post", !!(await t.gql("CreateTweet", { tweet_text: "admin test: restricted" })).errors);
await a.admin("setStatus", { id: target.id, status: "limited" });
const orgHome = postIds((await o.get("HomeTimeline", { count: 50 })).data.home.home_timeline_urt);
check("limited: gone from a non-follower's home feed", !orgHome.includes(post));
check("limited: still on their own profile", postIds((await o.get("UserTweets", { userId: target.id, count: 20 })).data.user.result.timeline.timeline).includes(post));
await a.admin("setStatus", { id: target.id, status: "suspended" });
check("suspended: can't sign in", (await session(targetName)) === undefined);
check("suspended: the old session is gone", (await t.admin("me")).status === 403);
check("suspended: the profile says so", (await o.get("UserByScreenName", { screen_name: targetName })).data.user?.result?.__typename === "UserUnavailable");
check("suspended: staff still see it", (await a.get("UserByScreenName", { screen_name: targetName })).data.user?.result?.__typename === "User");
await a.admin("setStatus", { id: target.id, status: "active" });
t = (await session(targetName))!;
check("reinstated: can sign in again", !!t);

// organisations
check("the organisation is listed", (await a.admin("orgs")).orgs?.some((x: any) => x.id === org.id));
await a.admin("addAffiliate", { orgId: org.id, screen_name: targetName });
const label = (await o.get("UserByScreenName", { screen_name: targetName })).data.user.result.affiliates_highlighted_label?.label;
check("an affiliate shows the organisation's badge", label?.description && label?.url?.url?.includes(orgName), label);
const orgUser = (await t.get("UserByScreenName", { screen_name: orgName })).data.user.result;
check("the organisation counts its affiliates", orgUser.business_account?.affiliates_count >= 1, orgUser.business_account);
check("and lists them on its Affiliates tab", userIds((await t.get("UserBusinessProfileTeamTimeline", { userId: org.id, count: 20 })).data.user.result.timeline.timeline).includes(target.id));
await a.admin("removeAffiliate", { orgId: org.id, userId: target.id });
check("removed affiliates lose the badge", !(await o.get("UserByScreenName", { screen_name: targetName })).data.user.result.affiliates_highlighted_label?.label?.url);

// invites and sign-up mode
const { codes } = await a.admin("createInvite", { count: 1, uses: 1, orgId: org.id });
const name = `adm${Date.now() % 1e8}`;
const signup = (f: Record<string, string>) => fetch(`${origin}/signup`, { method: "POST", body: new URLSearchParams({ username: name, name: "Admin Test", password: "testpass123", confirm: "testpass123", ...f }), redirect: "manual" });
await a.admin("setSignupMode", { mode: "closed" });
check("closed: sign-up refuses even good codes", (await signup({ code: codes[0] })).status === 400);
await a.admin("setSignupMode", { mode: "invite" });
check("an organisation's invite signs up and affiliates", (await signup({ code: codes[0] })).status === 303 && (await sql`select 1 from affiliations af join users u on u.id = af.user_id where u.screen_name = ${name}`).length === 1);
const { codes: [revoked] } = await a.admin("createInvite", {});
await a.admin("revokeInvite", { code: revoked });
check("a revoked code is refused", (await signup({ code: revoked, username: `${name}r` })).status === 400);
check("invites are listed with who used them", (await a.admin("invites")).invites?.find((i: any) => i.code === codes[0])?.used_by?.includes(name));

// posts, passwords, audit
check("posts can be found", (await a.admin("posts", { author: targetName })).posts?.some((p: any) => p.id === post));
await a.admin("deletePost", { id: post });
check("and deleted", (await sql`select 1 from posts where id = ${post}::bigint`).length === 0);
const reset = await a.admin("resetPassword", { id: target.id });
check("a password reset gives a working password", !!(await session(targetName, reset.password)));
const log = (await a.admin("audit")).entries ?? [];
check("the audit log records it all", ["set_status", "add_affiliate", "delete_post", "reset_password", "set_signup_mode"].every((x) => log.some((e: any) => e.action === x)));

// put things back
await sql`update users set password_hash = ${await Bun.password.hash(password)} where id = ${target.id}::bigint`;
await sql`delete from users where screen_name like ${`${name}%`}`;
await sql`delete from invites where code = any(${sql.array([codes[0], revoked], "TEXT")})`;
await sql.close();
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
