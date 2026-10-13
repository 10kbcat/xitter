// Our own sign-in page. The client's login screen talks a binary protocol to a
// separate service, so signing in happens here and the client starts already
// authenticated.

import { login, sessionCookies } from "./auth";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const page = (error = "", name = "") => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in</title>
<style>
	body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #000; color: #e7e9ea; font: 15px system-ui, sans-serif; }
	form { width: min(320px, calc(100vw - 32px)); display: grid; gap: 12px; }
	h1 { margin: 0 0 8px; font-size: 28px; }
	input { padding: 14px; border: 1px solid #333639; border-radius: 4px; background: #000; color: inherit; font: inherit; }
	input:focus { outline: 2px solid #1d9bf0; border-color: transparent; }
	button { padding: 12px; border: 0; border-radius: 999px; background: #eff3f4; color: #0f1419; font: inherit; font-weight: 700; cursor: pointer; }
	p { margin: 0; color: #f4212e; }
</style>
</head>
<body>
<form method="post" action="/login">
	<h1>Sign in</h1>
	${error ? `<p>${esc(error)}</p>` : ""}
	<input name="username" placeholder="Username" autocomplete="username" value="${esc(name)}" required autofocus>
	<input name="password" type="password" placeholder="Password" autocomplete="current-password" required>
	<button>Sign in</button>
</form>
</body>
</html>`;

const html = (body: string, status = 200) =>
	new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });

export const loginPage = () => html(page());

export async function handleLogin(req: Request): Promise<Response> {
	const form = await req.formData().catch(() => undefined);
	const username = String(form?.get("username") ?? "").replace(/^@/, "").trim();
	const password = String(form?.get("password") ?? "");
	const session = username && password ? await login(username, password) : undefined;
	if (!session) return html(page("Wrong username or password.", username), 401);
	const headers = new Headers({ location: "/home" });
	for (const c of sessionCookies(session)) headers.append("set-cookie", c);
	return new Response(null, { status: 303, headers });
}
