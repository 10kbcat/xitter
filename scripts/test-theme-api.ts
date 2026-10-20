// Dim and custom themes: GET/POST /i/api/xitter/theme, the editor page, and the
// shell's theme JSON. Puts the account's preferences back afterwards.
// usage: bun scripts/test-theme-api.ts <account> <password>
import { sql } from "../src/db";

const [name = "pozo", password = "testpass123"] = process.argv.slice(2);
const origin = `http://localhost:${process.env.PORT ?? 3000}`;
let failed = 0;
const check = (ok: unknown, what: string, detail?: unknown) => {
	console.log(`${ok ? "ok  " : "FAIL"} ${what}${detail === undefined || ok ? "" : `: ${JSON.stringify(detail).slice(0, 300)}`}`);
	if (!ok) failed++;
};

async function session(username: string) {
	const r = await fetch(`${origin}/login`, { method: "POST", body: new URLSearchParams({ username, password }), redirect: "manual" });
	const cookies = r.headers.getSetCookie().map((c) => c.split(";")[0]);
	const csrf = cookies.find((c) => c.startsWith("ct0="))!.slice(4);
	const cookie = cookies.join("; ");
	const headers = { cookie, "x-csrf-token": csrf, "content-type": "application/json" };
	const get = () => fetch(`${origin}/i/api/xitter/theme`, { headers }).then((x) => x.json() as Promise<any>);
	const post = (body: unknown, extra: HeadersInit = {}) => fetch(`${origin}/i/api/xitter/theme`, { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(body) });
	return { cookie, headers, get, post };
}

const [before] = await sql`select preferences from users where lower(screen_name) = lower(${name})`;
const s = await session(name);

try {
	await s.post({ clear: true });
	const none = await s.get();
	check(none.theme === null, "GET theme is none", none);

	const dim = await (await s.post({ theme: { id: "dim" } })).json();
	check(dim.theme?.id === "dim" && dim.theme?.bg?.stops?.[0] === "#15202b", "POST dim stores dim", dim);
	const got = await s.get();
	check(got.theme?.id === "dim" && got.theme?.text === "#f7f9f9", "GET returns dim", got);

	const custom = await (
		await s.post({
			theme: {
				id: "custom",
				base: "dark",
				bg: { stops: ["#0a0a12", "#180828"], angle: 120 },
				surface: "#121018",
				text: "#000000",
				accent: "#1d9bf0",
				button: { stops: ["#ffffff"], angle: 180 },
				buttonText: "#ffffff",
			},
		})
	).json();
	check(custom.theme?.text === "#ffffff" && custom.theme?.buttonText === "#0f1419", "unreadable text is clamped", custom.theme);
	check(Array.isArray(custom.warnings) && custom.warnings.length > 0, "and returns warnings", custom.warnings);

	const garbage = await s.post({ theme: { id: "nope", bg: "red" } });
	check(garbage.status === 400, "POST garbage is 400", garbage.status);

	const nocsrf = await fetch(`${origin}/i/api/xitter/theme`, {
		method: "POST",
		headers: { cookie: s.headers.cookie, "content-type": "application/json" },
		body: JSON.stringify({ theme: { id: "dim" } }),
	});
	check(nocsrf.status === 403, "POST without csrf is refused", nocsrf.status);

	await s.post({ theme: { id: "dim" } });
	const home = await fetch(`${origin}/home`, { headers: { cookie: s.cookie } });
	const html = await home.text();
	if (home.ok) check(html.includes("__XITTER__") && html.includes('"id":"dim"'), "shell HTML carries the theme JSON");
	else check(/no pinned client/.test(html), "home without a pinned client is the known empty-build page", home.status);

	const page = await fetch(`${origin}/account/theme`, { headers: { cookie: s.cookie } });
	const pageHtml = await page.text();
	check(page.ok && pageHtml.includes("<h1>Theme</h1>") && pageHtml.includes("Dim") && pageHtml.includes("Ember"), "/account/theme renders", page.status);

	const advanced = await (
		await s.post({
			theme: {
				id: "custom",
				base: "dark",
				bg: { stops: ["#0a0a12"], angle: 180 },
				surface: "#121018",
				text: "#f2f0ff",
				accent: "#8b7cff",
				button: { stops: ["#eef0ff"], angle: 180 },
				buttonText: "#070b1a",
				link: "#ffb020",
				muted: "#a090b0",
				reply: "#8b7cff",
				like: "#f91880",
			},
		})
	).json();
	check(advanced.theme?.link === "#ffb020" && advanced.theme?.muted === "#a090b0", "advanced fields round-trip", advanced.theme);

	const withFont = await (
		await s.post({
			theme: {
				id: "custom",
				base: "dark",
				bg: { stops: ["#0a0a12"], angle: 180 },
				surface: "#121018",
				text: "#f2f0ff",
				accent: "#8b7cff",
				button: { stops: ["#eef0ff"], angle: 180 },
				buttonText: "#070b1a",
				font: { ui: "Inter" },
			},
		})
	).json();
	const fontOk = withFont.theme?.font?.ui === "Inter";
	const fontWarn = Array.isArray(withFont.warnings) && withFont.warnings.some((w: string) => /couldn't load|Inter/i.test(w));
	check(fontOk || fontWarn, "theme with Inter font saves or warns", withFont);

	if (fontOk) {
		const css = await fetch(`${origin}/i/xitter/fonts/inter/fonts.css`);
		const cssText = await css.text();
		check(css.ok && (css.headers.get("content-type") ?? "").includes("text/css") && cssText.includes("/i/xitter/fonts/inter/") && cssText.includes('font-family:"Inter"'), "fonts.css is our own", css.status);
		const face = /url\((\/i\/xitter\/fonts\/inter\/[\w.-]+\.woff2)\)/.exec(cssText);
		if (face) {
			const woff = await fetch(`${origin}${face[1]}`);
			check(woff.ok && (woff.headers.get("content-type") ?? "").includes("woff2"), "woff2 is served", woff.status);
		} else check(false, "fonts.css names a woff2");
	}

	const badSlug = await fetch(`${origin}/i/xitter/fonts/../server.ts/fonts.css`);
	check(badSlug.status === 404, "bad font slug is 404", badSlug.status);
	const missing = await fetch(`${origin}/i/xitter/fonts/not-a-font/fonts.css`);
	check(missing.status === 404, "unknown font is 404", missing.status);

	const cleared = await (await s.post({ clear: true })).json();
	check(cleared.theme === null, "POST clear removes it", cleared);
	check((await s.get()).theme === null, "GET returns none after clear");
} finally {
	await sql`update users set preferences = ${JSON.stringify(before?.preferences ?? {})}::text::jsonb where lower(screen_name) = lower(${name})`;
}

console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
