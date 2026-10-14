// Our own sign-in and sign-up pages. The client's login screen talks a binary
// protocol to a separate service, so signing in happens here and the client
// starts already authenticated.

import { login, sessionCookies } from "./auth";
import { FLAGS } from "./flags";
import { SignupError, signUp } from "./invites";
import { type SignupMode, getSetting } from "./settings";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const layout = (title: string, body: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Xitter</title>
<link rel="icon" type="image/png" href="/public/favicon.png">
<style>
	.logo { width: 200px; margin: 0 0 16px; }
	body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #000; color: #e7e9ea; font: 15px system-ui, sans-serif; }
	form { width: min(320px, calc(100vw - 32px)); display: grid; gap: 12px; padding: 32px 0; }
	h1 { margin: 0 0 8px; font-size: 28px; }
	input { padding: 14px; border: 1px solid #333639; border-radius: 4px; background: #000; color: inherit; font: inherit; }
	input:focus { outline: 2px solid #1d9bf0; border-color: transparent; }
	button { padding: 12px; border: 0; border-radius: 999px; background: #eff3f4; color: #0f1419; font: inherit; font-weight: 700; cursor: pointer; }
	.error { margin: 0; color: #f4212e; }
	.alt { margin: 8px 0 0; color: #71767b; }
	.hint { margin: -6px 0 0; color: #71767b; font-size: 13px; }
	a { color: #1d9bf0; text-decoration: none; }
	fieldset { border: 0; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 6px; }
	legend { margin-bottom: 8px; color: #71767b; }
	fieldset label { cursor: pointer; }
	fieldset input { position: absolute; opacity: 0; pointer-events: none; }
	fieldset span { display: grid; place-items: center; width: 34px; height: 34px; border: 2px solid #333639; border-radius: 6px; color: #71767b; font-size: 13px; }
	fieldset img { width: 22px; height: 22px; border-radius: 3px; }
	fieldset input:checked + span { border-color: #1d9bf0; }
	fieldset input:focus-visible + span { outline: 2px solid #1d9bf0; }
</style>
</head>
<body>
${body}
</body>
</html>`;

const error = (message: string) => (message ? `<p class="error">${esc(message)}</p>` : "");

const signInPage = (message = "", name = "") =>
	layout(
		"Sign in",
		`<form method="post" action="/login">
	<img class="logo" src="/public/logo-dark.png" alt="Xitter">
	<h1>Sign in</h1>
	${error(message)}
	<input name="username" placeholder="Username" autocomplete="username" value="${esc(name)}" required autofocus>
	<input name="password" type="password" placeholder="Password" autocomplete="current-password" required>
	<button>Sign in</button>
	<p class="alt">Have an invite? <a href="/signup">Create an account</a></p>
</form>`,
	);

type SignupFields = { code?: string; username?: string; name?: string; flag?: string };

// one choice per flag, plus none; the badge shows next to the name
const flagPicker = (chosen = "") =>
	`<fieldset><legend>Flag next to your name (optional)</legend>
	<label title="None"><input type="radio" name="flag" value="" ${chosen ? "" : "checked"}><span>none</span></label>
	${Object.entries(FLAGS)
		.map(
			([id, f]) =>
				`<label title="${esc(f.name)}"><input type="radio" name="flag" value="${id}" ${chosen === id ? "checked" : ""}><span><img src="/public/flag-${id}.svg" alt="${esc(f.name)}"></span></label>`,
		)
		.join("")}
</fieldset>`;

const closedPage = () =>
	layout(
		"Sign-up closed",
		`<form>
	<img class="logo" src="/public/logo-dark.png" alt="Xitter">
	<h1>Sign-up is closed</h1>
	<p class="alt">This instance isn't taking new accounts right now. <a href="/login">Sign in</a></p>
</form>`,
	);

const signUpPage = (message = "", f: SignupFields = {}, mode: SignupMode = "invite") =>
	layout(
		"Create your account",
		`<form method="post" action="/signup">
	<img class="logo" src="/public/logo-dark.png" alt="Xitter">
	<h1>Create your account</h1>
	${error(message)}
	<input name="code" placeholder="Invite code${mode === "open" ? " (optional)" : ""}" value="${esc(f.code ?? "")}" autocomplete="off" ${mode === "open" ? "" : "required"} ${f.code ? "" : "autofocus"}>
	<input name="username" placeholder="Username" autocomplete="username" value="${esc(f.username ?? "")}" required minlength="4" maxlength="15" pattern="@?[A-Za-z0-9_]{4,15}" ${f.code ? "autofocus" : ""}>
	<p class="hint">4 to 15 letters, digits or underscores. This is your @handle.</p>
	<input name="name" placeholder="Display name" autocomplete="name" value="${esc(f.name ?? "")}" maxlength="50">
	<input name="password" type="password" placeholder="Password" autocomplete="new-password" required minlength="8">
	<input name="confirm" type="password" placeholder="Repeat password" autocomplete="new-password" required minlength="8">
	${flagPicker(f.flag)}
	<button>Create account</button>
	<p class="alt">Already have one? <a href="/login">Sign in</a></p>
</form>`,
	);

const html = (body: string, status = 200) =>
	new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });

function signedIn(session: { token: string; csrf: string; userId: string }): Response {
	const headers = new Headers({ location: "/home" });
	for (const c of sessionCookies(session)) headers.append("set-cookie", c);
	return new Response(null, { status: 303, headers });
}

async function fields(req: Request): Promise<Record<string, string>> {
	const form = await req.formData().catch(() => undefined);
	const out: Record<string, string> = {};
	if (form) for (const [k, v] of form) if (typeof v === "string") out[k] = v;
	return out;
}

export const loginPage = () => html(signInPage());

export async function handleLogin(req: Request): Promise<Response> {
	const f = await fields(req);
	const username = (f.username ?? "").replace(/^@/, "").trim();
	const password = f.password ?? "";
	const session = username && password ? await login(username, password) : undefined;
	if (!session) return html(signInPage("Wrong username or password.", username), 401);
	return signedIn(session);
}

export async function signupPage(url: URL): Promise<Response> {
	const mode = await getSetting("signup_mode");
	if (mode === "closed") return html(closedPage());
	return html(signUpPage("", { code: url.searchParams.get("code") ?? "" }, mode));
}

export async function handleSignup(req: Request): Promise<Response> {
	const f = await fields(req);
	const kept = { code: f.code, username: f.username, name: f.name, flag: f.flag };
	if ((f.password ?? "") !== (f.confirm ?? "")) return html(signUpPage("The passwords don't match.", kept, await getSetting("signup_mode")), 400);
	try {
		await signUp({ code: f.code ?? "", screenName: f.username ?? "", name: f.name ?? "", password: f.password ?? "", flag: f.flag });
	} catch (e) {
		if (e instanceof SignupError) return html(signUpPage(e.message, kept, await getSetting("signup_mode")), 400);
		throw e;
	}
	const session = await login((f.username ?? "").trim().replace(/^@/, ""), f.password ?? "");
	return signedIn(session!);
}
