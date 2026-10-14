// X's own sign-in screen, served by this instance. The client renders whatever
// Jetfuel screens jf.x.com sends (patch.ts points that host here), so the
// screens are X's captured ones (src/jf, made by scripts/jf-templates.ts) with
// our texts, links and accounts filled in.
//
//   GET  /onboarding/web(/landing)                username field
//   POST /onboarding/web/actions/begin_login      username and password
//   POST /onboarding/web/actions/login_enter_password
//        right password: "complete" plus session cookies; wrong: the same
//        screen again with the error under the field
//
// The first screen is the signed-in client's own sign-in dialog.

import { login, sessionCookies } from "./auth";
import { sql } from "./db";
import { type Message, encode, mapStrings } from "./jetfuel";
import { fromJson } from "./jetfuel-json";
import { settings } from "./settings";

const load = async (name: string): Promise<Message[]> => fromJson(await Bun.file(new URL(`./jf/${name}.json`, import.meta.url)).json());
// Takes out of a screen the parts that hold any of these texts. With `part` (a
// button is 7140) the nearest element of that type goes; otherwise the branch
// that sits beside the username field, i.e. the child of the nearest element
// that also holds the field.
function without(messages: Message[], texts: string[], part?: number): Message[] {
	const [, root] = messages[0];
	const parentOf = new Map<number, number>();
	root.els.forEach((e: any, i: number) => e.children.forEach((c: number) => parentOf.set(c, i)));
	const strings = (e: any) => [...e.props.values()].map((p: number) => root.props[p]).filter((p: any) => p[0] === 0).map((p: any) => p[1]);
	const holdsField = (i: number): boolean => strings(root.els[i]).includes("username_or_email") || root.els[i].children.some(holdsField);
	for (const text of texts) {
		let n = root.els.findIndex((e: any) => strings(e).includes(text));
		if (part !== undefined) while (n >= 0 && parentOf.has(n) && root.els[n].type !== part) n = parentOf.get(n)!;
		else while (n >= 0 && parentOf.has(n) && !holdsField(parentOf.get(n)!)) n = parentOf.get(n)!;
		const parent = parentOf.get(n);
		if (n < 0 || parent === undefined) continue;
		root.els[parent].children = root.els[parent].children.filter((c: number) => c !== n);
	}
	return messages;
}

const templates = {
	// no password reset by email yet
	password: without(await load("password"), ["Forgot password?"], 7140),
	// no phone numbers, Google or Apple accounts here
	landing: without(await load("landing"), ["Continue with phone", "Continue with Google", "Continue with Apple", "or"]),
	success: await load("success"),
	passkey: await load("passkey"),
};

// x.com's legal links become the instance's rules page
const LINKS: Record<string, string> = {
	"https://x.com/tos": "/rules",
	"https://x.com/privacy": "/rules",
	"https://help.x.com/rules-and-policies/twitter-cookies": "/rules",
};
const TEXTS: Record<string, () => string> = {
	"Terms of Service": () => "Rules",
	"Privacy Policy": () => "privacy",
	"Cookie Use": () => "cookies",
	Login: () => `Sign in to ${settings().instance_name}`,
	"See what's happening": () => `Sign in to ${settings().instance_name}`,
	"Select an option below:": () => "Enter your username to continue.",
	"Email or username": () => "Username",
};

function fill(messages: Message[], values: Record<string, string>): Message[] {
	return mapStrings(messages, (s) => {
		if (s in LINKS) return LINKS[s];
		if (s in TEXTS) return TEXTS[s]();
		return s.replace(/\{\{(\w+)\}\}/g, (_, k) => values[k] ?? "");
	});
}

// the form's field errors: the property that describes a form (type 30) holds
// [url, fields, errors, ...]; an error keyed by field name shows under it
function withError(messages: Message[], field: string, text: string): Message[] {
	for (const [tag, m] of messages) {
		if (tag !== 0) continue;
		for (const p of m.props) if (p[0] === 30) p[1][2] = new Map([[field, text]]);
	}
	return messages;
}

const respond = (messages: Message[], page = false, headers: Headers = new Headers()) => {
	headers.set("content-type", "text/plain");
	headers.set("x-jf-tag", "AgE");
	if (page) headers.set("x-jf-presentation", "page");
	headers.set("cache-control", "no-store");
	return new Response(encode(messages), { headers });
};

async function form(req: Request): Promise<Record<string, string>> {
	const f = await req.formData().catch(() => undefined);
	const out: Record<string, string> = {};
	if (f) for (const [k, v] of f) if (typeof v === "string") out[k] = v;
	return out;
}

const signInScreen = (username = "") => fill(templates.password, { username, session_token: crypto.randomUUID() });

export async function onboarding(req: Request, path: string): Promise<Response | undefined> {
	if (path === "/onboarding/web" || path === "/onboarding/web/landing") return respond(fill(templates.landing, {}), true);
	if (path === "/onboarding/web/remotes/passkey_one_fa") return respond(templates.passkey, true);
	if (req.method !== "POST") return undefined;

	if (path === "/onboarding/web/actions/begin_login") {
		const f = await form(req);
		return respond(signInScreen(String(f.username_or_email ?? "").trim().replace(/^@/, "")));
	}
	if (path === "/onboarding/web/actions/login_enter_password") {
		const f = await form(req);
		const username = String(f.username ?? "").trim().replace(/^@/, "");
		const session = username && f.password ? await login(username, f.password) : undefined;
		if (!session) return respond(withError(signInScreen(username), "password", "Wrong username or password."));
		const [user] = await sql`select screen_name from users where id = ${session.userId}::bigint`;
		const headers = new Headers();
		for (const c of sessionCookies(session)) headers.append("set-cookie", c);
		return respond(fill(templates.success, { user_id: session.userId, username: user.screen_name }), false, headers);
	}
	return undefined;
}
