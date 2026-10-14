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
import { CODE_DIGITS, SignupError, normalizeCode, signUp } from "./invites";
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

// The code screen's field (element type -1662) is a row of boxes, one per
// character (digits only); its length is property -3903.
const INVITE_LENGTH = CODE_DIGITS;
function codeLength(messages: Message[], length: number): Message[] {
	const [, root] = messages[0];
	for (const e of root.els) {
		if (e.type !== -1662 || !e.props.has(-3903)) continue;
		root.props.push([1, length]);
		e.props.set(-3903, root.props.length - 1);
	}
	// and the resend countdown under it (type 25739) goes with the resend button
	return without(messages, ["Didn't receive a code? Retry in  "], 25739);
}

// The setup screen enables Continue only once its username check (the
// suggest_username remote) has set an "available" flag. How a reply sets that
// flag isn't in any capture, so the rule drops the flags (the either-of, 13)
// and the username is checked on submit instead.
function withoutUsernameCheck(messages: Message[]): Message[] {
	const [, root] = messages[0];
	const drop = (c: any): any => {
		// "and" holds exactly two; with one side gone the other stands alone
		if (c[0] === 12) {
			const [a, b] = c[1].map(drop);
			return a && b ? [12, [a, b]] : (a ?? b);
		}
		if (c[0] === 13) return undefined;
		return c;
	};
	for (const p of root.props) if (p[0] === 22 && p[1][0] === 12 && JSON.stringify(p[1], (_, v) => (typeof v === "bigint" ? `${v}` : v)).includes("__$anyFieldErrors")) p[1] = drop(p[1]);
	return messages;
}

const templates = {
	// no password reset by email yet
	password: without(await load("password"), ["Forgot password?"], 7140),
	// no phone numbers, Google or Apple accounts here
	landing: without(await load("landing"), ["Continue with phone", "Continue with Google", "Continue with Apple", "or"]),
	// sign-up: X's emailed-code screen asks for the invite code instead
	code: codeLength(without(await load("code"), ["Send again"], 7140), INVITE_LENGTH),
	setup: withoutUsernameCheck(await load("setup")),
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
	"We sent you a security code": () => "Enter your invite code",
	"The code was sent to your device": () => `No account goes by that name yet. To create it, enter an invite to ${settings().instance_name}.`,
	"Didn't receive a code? ": () => "",
	"Choose a name, username, and password.": () => `Welcome to ${settings().instance_name}. Choose a name, username, and password.`,
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

// sign-ups in progress, between their screens
const signups = new Map<string, { username: string; code: string; at: number }>();
setInterval(() => {
	for (const [k, v] of signups) if (Date.now() - v.at > 30 * 60 * 1000) signups.delete(k);
}, 60_000).unref?.();

// "Set up your account" with the username they typed already in place
function setupScreen(token: string, username: string): Message[] {
	const messages = fill(templates.setup, { session_token: token });
	for (const [tag, m] of messages) {
		if (tag !== 0) continue;
		for (const p of m.props) if (p[0] === 30 && p[1][1] instanceof Map && p[1][1].has("username")) p[1][1].set("username", username);
	}
	return messages;
}

const signInScreen = (username = "") => fill(templates.password, { username, session_token: crypto.randomUUID() });

export async function onboarding(req: Request, path: string): Promise<Response | undefined> {
	if (path === "/onboarding/web" || path === "/onboarding/web/landing") return respond(fill(templates.landing, {}), true);
	if (path === "/onboarding/web/remotes/passkey_one_fa") return respond(templates.passkey, true);
	// "Username is available": the setup screen asks while typing
	if (path.startsWith("/onboarding/web/remotes/suggest_username")) return respond(templates.passkey, true);
	if (req.method !== "POST") return undefined;

	// One field for both: a known username goes on to its password; an unknown
	// one starts sign-up (X does the same with an email it doesn't know).
	if (path === "/onboarding/web/actions/begin_login") {
		const f = await form(req);
		const name = String(f.username_or_email ?? "").trim().replace(/^@/, "");
		const [user] = name ? await sql`select screen_name from users where lower(screen_name) = lower(${name}) and status <> 'suspended'` : [];
		if (user) return respond(signInScreen(user.screen_name));
		const mode = settings().signup_mode;
		if (mode === "closed" || !/^[A-Za-z0-9_]{1,15}$/.test(name))
			return respond(withError(fill(templates.landing, {}), "username_or_email", mode === "closed" ? "No account goes by that name." : "Usernames are letters, digits and underscores."), true);
		const token = crypto.randomUUID();
		signups.set(token, { username: name, code: "", at: Date.now() });
		return respond(mode === "open" ? setupScreen(token, name) : fill(templates.code, { session_token: token }));
	}
	// the invite code, checked here and spent when the account is made
	if (path === "/onboarding/web/actions/finish_verification") {
		const f = await form(req);
		const token = String(f.session_token ?? "");
		const s = signups.get(token);
		if (!s) return respond(withError(fill(templates.landing, {}), "username_or_email", "That took too long. Please start again."), true);
		const code = normalizeCode(String(f.code ?? ""));
		const [ok] = await sql`select 1 from invites where code = ${code} and not revoked and uses < max_uses and (expires_at is null or expires_at > now())`;
		if (!ok) return respond(withError(fill(templates.code, { session_token: token }), "code", "That invite code is not valid or has been used up."));
		s.code = code;
		return respond(setupScreen(token, s.username));
	}
	if (path === "/onboarding/web/actions/verify_signup" || path === "/onboarding/web/actions/signup") {
		const f = await form(req);
		const token = String(f.session_token ?? "");
		const s = signups.get(token);
		if (!s) return respond(withError(fill(templates.landing, {}), "username_or_email", "That took too long. Please start again."), true);
		try {
			await signUp({ code: s.code, screenName: String(f.username ?? s.username), name: String(f.name ?? ""), password: String(f.password ?? "") });
		} catch (e) {
			if (!(e instanceof SignupError)) throw e;
			const field = /password/i.test(e.message) ? "password" : /name/i.test(e.message) && !/user/i.test(e.message) ? "name" : "username";
			return respond(withError(setupScreen(token, String(f.username ?? s.username)), field, e.message));
		}
		signups.delete(token);
		const session = await login(String(f.username ?? s.username), String(f.password ?? ""));
		const headers = new Headers();
		for (const c of sessionCookies(session!)) headers.append("set-cookie", c);
		return respond(fill(templates.success, { user_id: session!.userId, username: String(f.username ?? s.username) }), false, headers);
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
