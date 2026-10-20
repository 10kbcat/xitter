import puppeteer from "/workspace/xitterbadge/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js";
import { readFileSync } from "node:fs";

const origin = `http://localhost:${process.env.PORT ?? 3000}`;
const [token, ct0, userId] = readFileSync("/tmp/xsess", "utf8").trim().split(/\s+/);
if (!token || !ct0 || !userId) throw new Error("need /tmp/xsess: auth_token ct0 userId");

const NAVY = {
	theme: {
		id: "custom",
		base: "dark",
		bg: { stops: ["#120a35", "#1b1046"], angle: 180 },
		surface: "#1a1440",
		text: "#f4f1ff",
		accent: "#4a90e2",
		button: { stops: ["#4a90e2", "#7c5cff"], angle: 90 },
		buttonText: "#ffffff",
	},
};

const looks = [
	{ name: "Default", body: { mode: "light" } },
	{ name: "Dim", body: { theme: { id: "dim" } } },
	{ name: "Lights out", body: { mode: "dark" } },
	{ name: "custom-navy", body: NAVY },
	{ name: "custom-accent", body: { mode: "dark", accent: "#ff3d7f" } },
] as const;

const paths = [
	"/home",
	"/notifications",
	"/coah",
	"/explore",
	"/coah/lists",
	"/i/bookmarks",
	"/messages",
	"/settings/account",
	"/settings/display",
	"/search?q=x",
];

const widths = [1400, 1100];

type Flag = {
	look: string;
	width: number;
	path: string;
	kind: string;
	text: string;
	bg: string;
	accent: string;
};

const flags: Flag[] = [];

const browser = await puppeteer.launch({
	executablePath: "/usr/bin/google-chrome",
	headless: "new",
	args: ["--no-sandbox", "--disable-gpu"],
});
const page = await browser.newPage();
await page.setCookie(
	{ name: "auth_token", value: token, domain: "localhost", path: "/" },
	{ name: "ct0", value: ct0, domain: "localhost", path: "/" },
	{ name: "twid", value: `u%3D${userId}`, domain: "localhost", path: "/" },
);

const postLook = async (body: unknown) => {
	const r = await page.evaluate(async (payload, csrf) => {
		const res = await fetch("/i/api/xitter/theme", {
			method: "POST",
			credentials: "same-origin",
			headers: { "content-type": "application/json", "x-csrf-token": csrf },
			body: JSON.stringify(payload),
		});
		return { ok: res.ok, d: await res.json() };
	}, body, ct0);
	if (!r.ok) throw new Error(`theme post failed ${JSON.stringify(r.d)}`);
};

const rgb = (s: string) => {
	const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([0-9.]+))?\)/.exec(s);
	if (!m) return null;
	return { r: +m[1], g: +m[2], b: +m[3], a: m[4] == null ? 1 : +m[4] };
};

const hexRgb = (h: string) => {
	const m = /^#([0-9a-f]{6})$/i.exec(h.trim());
	if (!m) return null;
	return { r: parseInt(m[1].slice(0, 2), 16), g: parseInt(m[1].slice(2, 4), 16), b: parseInt(m[1].slice(4, 6), 16), a: 1 };
};

await page.goto(`${origin}/home`, { waitUntil: "networkidle2", timeout: 60000 }).catch(() =>
	page.goto(`${origin}/home`, { waitUntil: "domcontentloaded", timeout: 60000 }),
);

for (const look of looks) {
	await postLook(look.body);
	for (const width of widths) {
		await page.setViewport({ width, height: 900 });
		for (const path of paths) {
			await page.goto(`${origin}${path}`, { waitUntil: "networkidle2", timeout: 60000 }).catch(() =>
				page.goto(`${origin}${path}`, { waitUntil: "domcontentloaded", timeout: 60000 }),
			);
			await new Promise((r) => setTimeout(r, 1800));
			const found = await page.evaluate(() => {
				const parse = (s: string) => {
					const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([0-9.]+))?\)/.exec(s);
					return m ? { r: +m[1], g: +m[2], b: +m[3], a: m[4] == null ? 1 : +m[4] } : null;
				};
				const hex = (h: string) => {
					const m = /^#([0-9a-f]{6})$/i.exec(h.trim());
					return m ? { r: parseInt(m[1].slice(0, 2), 16), g: parseInt(m[1].slice(2, 4), 16), b: parseInt(m[1].slice(4, 6), 16), a: 1 } : null;
				};
				const near = (a: { r: number; g: number; b: number; a: number }, b: { r: number; g: number; b: number; a: number }) =>
					a.a > 0.35 && Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b) <= 36;
				const root = getComputedStyle(document.documentElement);
				const accents = [
					hex(root.getPropertyValue("--xt-accent")),
					hex(root.getPropertyValue("--xt-badge")),
					parse("rgb(29, 155, 240)"),
					parse("rgb(74, 144, 226)"),
					parse("rgb(255, 61, 127)"),
				].filter((c): c is { r: number; g: number; b: number; a: number } => !!c);
				const accentish = (bg: string) => {
					const c = parse(bg);
					if (!c || c.a < 0.35) return false;
					return accents.some((a) => near(c, a));
				};
				const labelOf = (rootEl: Element) => {
					const nodes = [...rootEl.querySelectorAll("div,span")].filter((el) => {
						const t = (el.textContent || "").replace(/\s+/g, " ").trim();
						if (!t || t.length > 48 || /^\d+$/.test(t)) return false;
						const kids = [...el.children].filter((c) => (c.textContent || "").trim());
						return kids.length === 0;
					});
					return nodes[0] || null;
				};
				const hits: { kind: string; text: string; bg: string; accent: string }[] = [];
				const add = (kind: string, rootEl: Element) => {
					const label = labelOf(rootEl);
					if (!label) return;
					const bg = getComputedStyle(label).backgroundColor;
					if (!accentish(bg)) return;
					hits.push({
						kind,
						text: (label.textContent || "").replace(/\s+/g, " ").trim().slice(0, 40),
						bg,
						accent: root.getPropertyValue("--xt-accent").trim(),
					});
				};
				for (const tab of document.querySelectorAll("[role=tab][aria-selected=true], [role=tab][aria-current]")) add("tab", tab);
				const here = location.pathname;
				for (const a of document.querySelectorAll('nav a[href], [data-testid^="AppTabBar_"][href]')) {
					const href = a.getAttribute("href") || "";
					if (!href.startsWith("/")) continue;
					const on =
						href === here ||
						(href !== "/" && here.startsWith(href) && (here.length === href.length || here[href.length] === "/")) ||
						a.getAttribute("aria-current") === "page";
					if (on) add("nav", a);
				}
				if (here.startsWith("/settings/")) {
					for (const a of document.querySelectorAll('a[href^="/settings/"]')) {
						const href = a.getAttribute("href") || "";
						if (href === here || a.getAttribute("aria-selected") === "true") add("settings", a);
					}
				}
				return hits;
			});
			for (const h of found) flags.push({ look: look.name, width, path, ...h });
			const actions = await page.evaluate(() => {
				const parse = (s: string) => {
					const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([0-9.]+))?\)/.exec(s);
					return m ? { r: +m[1], g: +m[2], b: +m[3], a: m[4] == null ? 1 : +m[4] } : null;
				};
				const hex = (h: string) => {
					const m = /^#([0-9a-f]{6})$/i.exec(h.trim());
					return m ? { r: parseInt(m[1].slice(0, 2), 16), g: parseInt(m[1].slice(2, 4), 16), b: parseInt(m[1].slice(4, 6), 16), a: 1 } : null;
				};
				const near = (a: { r: number; g: number; b: number; a: number }, b: { r: number; g: number; b: number; a: number }) =>
					a.a > 0.35 && Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b) <= 36;
				const root = getComputedStyle(document.documentElement);
				const hot = [
					hex(root.getPropertyValue("--xt-accent")),
					hex(root.getPropertyValue("--xt-reply")),
					hex(root.getPropertyValue("--xt-repost")),
					hex(root.getPropertyValue("--xt-like")),
					hex(root.getPropertyValue("--xt-bookmark")),
					parse("rgb(29, 155, 240)"),
					parse("rgb(0, 186, 124)"),
					parse("rgb(249, 24, 128)"),
					parse("rgb(169, 112, 255)"),
				].filter((c): c is { r: number; g: number; b: number; a: number } => !!c);
				const hits: { kind: string; text: string; bg: string; accent: string }[] = [];
				for (const btn of document.querySelectorAll("[data-testid=reply],[data-testid=retweet],[data-testid=like],[data-testid=bookmark]")) {
					const svg = btn.querySelector("svg");
					if (!svg) continue;
					const color = getComputedStyle(svg).color;
					const c = parse(color);
					if (c && hot.some((h) => near(c, h))) {
						hits.push({
							kind: "action-rest",
							text: btn.getAttribute("data-testid") || "",
							bg: color,
							accent: root.getPropertyValue("--xt-accent").trim(),
						});
					}
				}
				return hits;
			});
			for (const h of actions) flags.push({ look: look.name, width, path, ...h });
			if (path === "/home" && width === 1400) {
				const box = await page.$('[data-testid="SearchBox_Search_Input"]');
				if (box) {
					await box.click();
					await page.keyboard.type("verification", { delay: 20 });
					await new Promise((r) => setTimeout(r, 2000));
					const layer = await page.evaluate(() => {
						const parse = (s: string) => {
							const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([0-9.]+))?\)/.exec(s);
							return m ? { r: +m[1], g: +m[2], b: +m[3], a: m[4] == null ? 1 : +m[4] } : null;
						};
						const node = [...document.querySelectorAll("div")].find((el) => {
							const t = (el.textContent || "").replace(/\s+/g, " ");
							return /Search for/.test(t) && t.length < 120 && getComputedStyle(el).position === "fixed";
						});
						if (!node) return { kind: "typeahead-missing", text: "", bg: "none", accent: "" };
						const bg = getComputedStyle(node).backgroundColor;
						const c = parse(bg);
						if (c && c.a >= 0.9) return null;
						return { kind: "typeahead", text: "Search for", bg, accent: getComputedStyle(document.documentElement).getPropertyValue("--xt-menu").trim() };
					});
					if (layer) flags.push({ look: look.name, width, path, ...layer });
					await page.keyboard.press("Escape");
				}
			}
		}
	}
}

await browser.close();

if (!flags.length) {
	console.log("check-tab-highlights: labels, resting actions, and typeahead layers are clean");
	process.exit(0);
}
console.log(`check-tab-highlights: ${flags.length} hits`);
for (const f of flags) console.log(`  ${f.look} ${f.width} ${f.path} ${f.kind} "${f.text}" bg=${f.bg} accent=${f.accent}`);
process.exit(1);
