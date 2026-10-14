// The rules page, and sign-in by form post for scripts. People sign in and up
// in X's own dialog, served by onboarding.ts.

import { login, sessionCookies } from "./auth";
import { settings } from "./settings";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const layout = (title: string, body: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · ${esc(settings().instance_name)}</title>
<link rel="icon" type="image/png" href="/public/favicon.png">
<style>
	.logo { width: 200px; margin: 0 0 16px; }
	body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #000; color: #e7e9ea; font: 15px system-ui, sans-serif; }
	form { width: min(560px, calc(100vw - 32px)); display: grid; gap: 12px; padding: 32px 0; }
	h1 { margin: 0 0 8px; font-size: 28px; }
	.alt { margin: 8px 0 0; color: #71767b; }
	.rules { margin: 0 0 4px; white-space: pre-wrap; line-height: 1.45; }
	a { color: #1d9bf0; text-decoration: none; }
	.source { position: fixed; bottom: 12px; left: 0; right: 0; text-align: center; color: #71767b; font-size: 13px; }
</style>
</head>
<body>
${body}
<p class="source">${esc(settings().instance_name)} runs <a href="${esc(settings().source_url)}">open source</a> software (AGPL-3.0)</p>
</body>
</html>`;

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

// For scripts and tests; people sign in through X's own dialog (onboarding.ts).
export async function handleLogin(req: Request): Promise<Response> {
	const f = await fields(req);
	const username = (f.username ?? "").replace(/^@/, "").trim();
	const password = f.password ?? "";
	const session = username && password ? await login(username, password) : undefined;
	if (!session) return new Response("Wrong username or password.", { status: 401 });
	return signedIn(session);
}

// the instance's rules, as written in the admin panel: blank lines split paragraphs
export function rulesPage(): Response {
	const rules = settings().rules.trim();
	const body = rules ? rules.split(/\n\s*\n/).map((p) => `<p class="rules">${esc(p)}</p>`).join("") : `<p class="alt">This instance hasn't written any rules yet.</p>`;
	return html(
		layout(
			"Rules",
			`<form>
	<img class="logo" src="/public/logo-dark.png" alt="${esc(settings().instance_name)}">
	<h1>Rules</h1>
	${body}
	<p class="alt"><a href="/">Sign in or create an account</a></p>
</form>`,
		),
	);
}
