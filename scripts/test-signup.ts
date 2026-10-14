// End-to-end check of invite sign-up against a running server. Makes its own
// invite and removes the account it creates.
// usage: bun scripts/test-signup.ts

import { sql } from "../src/db";
import { createInvite } from "../src/invites";

const origin = `http://localhost:${process.env.PORT ?? 3000}`;
const name = `t${Date.now() % 1e9}`;

let failures = 0;
function check(label: string, ok: boolean, detail: unknown = "") {
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail === "" ? "" : `: ${JSON.stringify(detail)}`}`);
}

const post = (f: Record<string, string>) => fetch(`${origin}/signup`, { method: "POST", body: new URLSearchParams(f), redirect: "manual" });
const errorOf = async (r: Response) => (await r.text()).match(/class="error">([^<]*)/)?.[1] ?? "";
const form = (o: Record<string, string> = {}) => ({ username: name, name: "Signup Test", password: "testpass123", confirm: "testpass123", flag: "trans", ...o });

const code = await createInvite();
const page = await (await fetch(`${origin}/signup?code=${code}`)).text();
check("the invite link fills in the code", page.includes(`value="${code}"`));

let r = await post(form({ code: "AAAA-BBBB-CCCC" }));
check("an unknown code is refused", r.status === 400 && /not valid/.test(await errorOf(r)));
r = await post(form({ code, confirm: "different" }));
check("passwords must match", r.status === 400 && /match/.test(await errorOf(r)));
r = await post(form({ code, username: "settings" }));
check("reserved names are refused", r.status === 400 && /reserved/.test(await errorOf(r)));
r = await post(form({ code, username: "ab" }));
check("short names are refused", r.status === 400 && /4 to 15/.test(await errorOf(r)));
r = await post(form({ code, username: "POZO" }));
check("taken names are refused, whatever the case", r.status === 400 && /taken/.test(await errorOf(r)));

r = await post(form({ code: code.toLowerCase().replace(/-/g, " ") }));
const cookies = r.headers.getSetCookie().map((c) => c.split(";")[0]);
check("sign-up works with the code typed loosely, and signs in", r.status === 303 && cookies.some((c) => c.startsWith("auth_token=")), r.status);

const csrf = cookies.find((c) => c.startsWith("ct0="))?.slice(4) ?? "";
const vars = encodeURIComponent(JSON.stringify({ screen_name: name }));
const user = (await (await fetch(`${origin}/i/api/graphql/q/UserByScreenName?variables=${vars}`, { headers: { cookie: cookies.join("; "), "x-csrf-token": csrf } })).json())
	.data?.user?.result;
check("the new account is signed in and visible", user?.core?.screen_name === name);
check("the chosen flag shows as the badge", /flag-trans\.svg$/.test(user?.affiliates_highlighted_label?.label?.badge?.url ?? ""), user?.affiliates_highlighted_label);
// the client reads its own account from the page's start-up state
const home = await (await fetch(`${origin}/home`, { headers: { cookie: cookies.join("; ") } })).text();
check("new accounts get Edit profile, not the onboarding flow", home.includes('"default_profile_image":false'));

// the flag picker in the Edit profile dialog posts here
const setFlag = (flag: string) =>
	fetch(`${origin}/i/api/1.1/account/update_flag.json`, { method: "POST", headers: { cookie: cookies.join("; "), "x-csrf-token": csrf }, body: new URLSearchParams({ flag }) });
check("an unknown flag is refused", (await setFlag("nope")).status === 403);
check("the flag can be changed", (await setFlag("pan")).ok);
const relabelled = (await (await fetch(`${origin}/i/api/graphql/q/UserByScreenName?variables=${vars}`, { headers: { cookie: cookies.join("; "), "x-csrf-token": csrf } })).json()).data
	?.user?.result;
check("and shows the new badge", /flag-pan\.svg$/.test(relabelled?.affiliates_highlighted_label?.label?.badge?.url ?? ""));
check("and can be removed", (await setFlag("")).ok);

r = await post(form({ code, username: `${name}b` }));
check("a used-up code is refused", r.status === 400 && /used up/.test(await errorOf(r)));

await sql`delete from users where screen_name = ${name}`;
await sql`delete from invites where code = ${code}`;
await sql.close();
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
