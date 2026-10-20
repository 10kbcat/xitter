import { expect, test } from "bun:test";
import { THEME_SCRIPT } from "../src/themes/client";
import { pageChromeVars as pageChromeVarsEs5 } from "../src/themes/page-chrome-es5.js";
import { bootCss, PAGE_CHROME_SLOTS, pageChromeCss, pageChromeRules, pageChromeVars, PREVIEW_CHROME_SLOTS, type BackgroundPaint } from "../src/themes/css";
import { type Theme } from "../src/themes/presets";
import {
	BACKGROUND_OMITTED,
	THEME_FILE_MAX,
	exportTheme,
	importTheme,
	mergeSavedBackground,
	parseLookWrite,
	sanitiseTheme,
} from "../src/themes/validate";
import { acceptThemePhoto } from "../src/media";
import { familyFromSlug, fontSlug, validateFamily } from "../src/fonts";

const custom: Theme = {
	id: "custom",
	base: "dark",
	bg: { stops: ["#0a0a12", "#180828"], angle: 120 },
	surface: "#121018",
	text: "#ffffff",
	accent: "#1d9bf0",
	button: { stops: ["#ffffff", "#eeeeee"], angle: 180 },
	buttonText: "#000000",
};

const fileOf = (theme: unknown) => JSON.stringify({ format: "xitter-theme", version: 1, theme });

const PNG_1X1 = Buffer.from(
	"89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082",
	"hex",
);

function gif({ width = 1, height = 1, extra = "" } = {}) {
	const b = Buffer.alloc(35);
	b.write("GIF89a", 0, "latin1");
	b.writeUInt16LE(width, 6);
	b.writeUInt16LE(height, 8);
	b[10] = 0;
	b[11] = 0;
	b[12] = 0;
	b[13] = 0x2c;
	b.writeUInt16LE(0, 14);
	b.writeUInt16LE(0, 16);
	b.writeUInt16LE(width, 18);
	b.writeUInt16LE(height, 20);
	b[22] = 0;
	b[23] = 2;
	b[24] = 2;
	b[25] = 0x4c;
	b[26] = 0x01;
	b[27] = 0;
	b[28] = 0x3b;
	return extra ? Buffer.concat([b.subarray(0, 29), Buffer.from(extra)]) : b.subarray(0, 29);
}

test("unknown keys are still dropped on read", () => {
	const got = sanitiseTheme({ id: "dim", extra: true, nested: { a: 1 } });
	expect(got?.theme.id).toBe("dim");
	expect(got && "extra" in got.theme).toBe(false);
});

test("save rejects an unknown theme key with a path", () => {
	const got = parseLookWrite({ theme: { id: "dim", extra: true } });
	expect(got.ok).toBe(false);
	if (got.ok) return;
	expect(got.errors?.some((e) => e.path === "extra" && /unknown/.test(e.message))).toBe(true);
});

test("import accepts a share file and strips a media id on export", () => {
	const painted = sanitiseTheme({
		...custom,
		background: { fit: "cover", position: "center", dim: 20, blur: 4, mediaId: "123" },
	})!.theme;
	const file = exportTheme(painted);
	expect(file.format).toBe("xitter-theme");
	expect(file.version).toBe(1);
	expect(file.theme.background).toEqual({ fit: "cover", position: "center", dim: 20, blur: 4, scale: 100, repeat: "repeat", panel: 72 });
	expect(JSON.stringify(file)).not.toContain("mediaId");
	expect(JSON.stringify(file)).not.toContain("/media/");
	const imported = importTheme(JSON.stringify(file));
	expect(imported.ok).toBe(true);
	if (!imported.ok) return;
	expect(imported.warnings).toContain(BACKGROUND_OMITTED);
	expect(imported.theme.background && "mediaId" in imported.theme.background).toBe(false);
});

test("a colour save keeps the stored picture", () => {
	const previous = sanitiseTheme({
		...custom,
		background: { fit: "cover", position: "top", dim: 10, blur: 2, mediaId: "123" },
	})!.theme;
	const next = mergeSavedBackground(previous, custom, "keep", false);
	expect(next.background?.mediaId).toBe("123");
	expect(mergeSavedBackground(previous, custom, "clear", false).background).toBeUndefined();
});

test("peel keeps a picture only on custom themes", () => {
	const previous = sanitiseTheme({
		...custom,
		background: { fit: "cover", position: "center", dim: 30, blur: 2, mediaId: "123" },
	})!.theme;
	const dim = parseLookWrite({ theme: { id: "dim" } });
	expect(dim.ok).toBe(true);
	if (!dim.ok || dim.write.type !== "paint") return;
	expect(mergeSavedBackground(previous, dim.write.theme, dim.write.peel, dim.write.mediaIdSent).background).toBeUndefined();
	const sunset = parseLookWrite({ theme: { id: "sunset" } });
	expect(sunset.ok).toBe(true);
	if (!sunset.ok || sunset.write.type !== "paint") return;
	expect(mergeSavedBackground(previous, sunset.write.theme, sunset.write.peel, sunset.write.mediaIdSent).background).toBeUndefined();
	const painted = parseLookWrite({
		theme: {
			id: "custom",
			base: "dark",
			bg: { stops: ["#0a0a12"], angle: 120 },
			surface: "#121018",
			text: "#ffffff",
			accent: "#1d9bf0",
			button: { stops: ["#ffffff"], angle: 180 },
			buttonText: "#000000",
		},
	});
	expect(painted.ok).toBe(true);
	if (!painted.ok || painted.write.type !== "paint") return;
	expect(mergeSavedBackground(previous, painted.write.theme, painted.write.peel, painted.write.mediaIdSent).background?.mediaId).toBe("123");
	const light = parseLookWrite({ mode: "light" });
	const dark = parseLookWrite({ mode: "dark" });
	expect(light.ok && light.write.type === "plain").toBe(true);
	expect(dark.ok && dark.write.type === "plain").toBe(true);
});

test("painted wrap skips Color options the same way accent wrap does", () => {
	const wrapFn = THEME_SCRIPT.slice(THEME_SCRIPT.indexOf("function wrap(sel, pageBg)"), THEME_SCRIPT.indexOf("function paint()"));
	const wrapAccentFn = THEME_SCRIPT.slice(THEME_SCRIPT.indexOf("function wrapAccent(sel)"), THEME_SCRIPT.indexOf("function paintAccent()"));
	expect(wrapAccentFn).toContain('[aria-label="Color options"] *');
	expect(wrapFn).toContain('[aria-label="Color options"] *');
	expect(THEME_SCRIPT).toContain('lightsCard.querySelector("input")');
});

test("paint does not force badge fill onto notification labels", () => {
	const paint = THEME_SCRIPT.slice(THEME_SCRIPT.indexOf("function paint()"), THEME_SCRIPT.indexOf("function wrapAccent"));
	const extras = [...paint.matchAll(/css\.push\('((?:\\'|[^'])*)'\)/g)].map((m) => m[1].replace(/\\'/g, "'"));
	const badge = extras.filter((rule) => /--xt-badge/.test(rule));
	expect(badge.length).toBe(1);
	expect(badge[0]).toContain('[data-testid="AppTabBar_Notifications_Link"] div[style*="background"]');
	expect(badge[0]).not.toContain("div[dir]");
	for (const rule of extras) {
		const brace = rule.indexOf("{");
		if (brace < 0) continue;
		const sel = rule.slice(0, brace);
		const decl = rule.slice(brace);
		if (!/background(?:-color)?\s*:/.test(decl)) continue;
		expect(sel.includes("div[dir]") && !/style\*=["']background/.test(sel)).toBe(false);
	}
});

test("paint leaves action icons grey at rest and only recolours hover", () => {
	const paint = THEME_SCRIPT.slice(THEME_SCRIPT.indexOf("function paint()"), THEME_SCRIPT.indexOf("function wrapAccent"));
	expect(paint).not.toContain('[data-testid="reply"],html[data-xitter-theme] [data-testid="reply"] svg{color:var(--xt-reply)');
	expect(paint).not.toContain('[data-testid="retweet"],html[data-xitter-theme] [data-testid="retweet"] svg{color:var(--xt-repost)');
	expect(paint).not.toContain('[data-testid="like"],html[data-xitter-theme] [data-testid="like"] svg{color:var(--xt-like)');
	expect(paint).not.toContain('[data-testid="bookmark"],html[data-xitter-theme] [data-testid="bookmark"] svg');
	expect(paint).toContain('[data-testid="reply"]:hover,html[data-xitter-theme] [data-testid="reply"]:hover svg{color:var(--xt-reply)');
	expect(paint).toContain('[data-testid="retweet"]:hover,html[data-xitter-theme] [data-testid="retweet"]:hover svg{color:var(--xt-repost)');
	expect(paint).toContain('[data-testid="like"]:hover,html[data-xitter-theme] [data-testid="like"]:hover svg{color:var(--xt-like)');
	expect(paint).toContain('[data-testid="bookmark"]:hover,html[data-xitter-theme] [data-testid="bookmark"]:hover svg');
	expect(paint).toContain('[aria-label="Share post"]:hover svg');
	expect(paint).not.toContain('[aria-label="Share post"] svg{color:var(--xt-bookmark)');
});

test("paint keeps page-bg overlays on the menu surface", () => {
	const paint = THEME_SCRIPT.slice(THEME_SCRIPT.indexOf("function paint()"), THEME_SCRIPT.indexOf("function wrapAccent"));
	expect(paint).toContain('add("pagebg","background-color:transparent!important",true)');
	expect(paint).toContain('wrap(":is("+found.pagebg.join(",")+"):is("+posSels.join(",")+")")');
	expect(paint).toContain("{background:var(--xt-menu)!important}");
	expect(paint).toContain('r.style.position==="fixed"||r.style.position==="absolute"');
});

test("overlay menu rules carry the same frost skip as the transparent page-bg rule", () => {
	// With an image background the transparent page-bg rule gets a long :not() chain.
	// If the overlay rules lack it they lose on specificity and the typeahead goes see-through.
	const paint = THEME_SCRIPT.slice(THEME_SCRIPT.indexOf("function paint()"), THEME_SCRIPT.indexOf("function wrapAccent"));
	const block = paint.slice(paint.indexOf("if((found.pagebg||[]).length&&posSels.length){"), paint.indexOf('add("surface"'));
	const on = block.indexOf('glassOn=!!(theme.background&&typeof X.pageChrome==="string"&&X.pageChrome)');
	expect(on).toBeGreaterThan(0);
	expect(on).toBeLessThan(block.indexOf("{background:var(--xt-menu)!important}"));
	expect(block.lastIndexOf("glassOn=false")).toBeGreaterThan(block.lastIndexOf("{background:var(--xt-menu)!important}"));
});

const attacks = [
	"#fff;}body{display:none",
	"red",
	"expression(alert(1))",
	"javascript:alert(1)",
	"@import",
	"url(https://evil)",
	"</style><script>alert(1)</script>",
];

for (const attack of attacks) {
	test(`import rejects css injection ${attack.slice(0, 24)}`, () => {
		const fields = ["text", "buttonText", "surface", "accent", "link", "bg"];
		for (const field of fields) {
			const theme = { ...custom, bg: { ...custom.bg }, button: { ...custom.button } } as Record<string, unknown>;
			if (field === "bg") theme.bg = { stops: [attack, "#000000"], angle: 180 };
			else theme[field] = attack;
			const got = importTheme(fileOf(theme));
			expect(got.ok).toBe(false);
			if (got.ok) return;
			const blob = JSON.stringify(got);
			expect(blob).not.toContain("display:none");
			expect(pageChromeCss()).not.toContain(attack);
			expect(bootCss(custom)).not.toContain(attack);
		}
	});
}

test("import rejects prototype pollution keys", () => {
	const cases = [
		'{"format":"xitter-theme","version":1,"__proto__":{"polluted":true},"theme":{"id":"custom"}}',
		'{"format":"xitter-theme","version":1,"theme":{"constructor":{"prototype":{"x":1}},"id":"custom"}}',
		'{"format":"xitter-theme","version":1,"theme":{"prototype":{"x":1},"id":"custom"}}',
	];
	for (const text of cases) {
		const got = importTheme(text);
		expect(got.ok).toBe(false);
		if (got.ok) return;
		expect(got.errors.some((e) => /banned|unknown|forbidden/.test(e.message))).toBe(true);
		expect(JSON.stringify(got)).not.toContain("polluted");
	}
	expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
});

test("import rejects a file over 64 KB before parsing", () => {
	const text = `{"format":"xitter-theme","version":1,"theme":{"pad":"${"a".repeat(THEME_FILE_MAX)}"}}`;
	expect(Buffer.byteLength(text)).toBeGreaterThan(THEME_FILE_MAX);
	const got = importTheme(text);
	expect(got.ok).toBe(false);
	if (!got.ok) expect(got.errors[0]?.message).toBe("file is too large");
});

test("import rejects nesting deeper than 6", () => {
	const deep = { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } };
	const got = importTheme(fileOf({ ...custom, extra: deep }));
	expect(got.ok).toBe(false);
	if (!got.ok) expect(got.errors.some((e) => /deep|unknown/.test(e.message))).toBe(true);
});

test("import rejects extra keys at every level", () => {
	expect(importTheme(JSON.stringify({ format: "xitter-theme", version: 1, theme: custom, extra: 1 })).ok).toBe(false);
	expect(importTheme(fileOf({ ...custom, nope: true })).ok).toBe(false);
	expect(importTheme(fileOf({ ...custom, bg: { ...custom.bg, extra: 1 } })).ok).toBe(false);
	expect(importTheme(fileOf({ ...custom, font: { ui: "Inter", extra: 1 } })).ok).toBe(false);
	expect(importTheme(fileOf({ ...custom, background: { fit: "cover", position: "center", dim: 0, blur: 0, extra: 1 } })).ok).toBe(false);
});

test("import rejects wrong types and one-stop or hash-rgb colours", () => {
	expect(importTheme(fileOf({ ...custom, text: 12 })).ok).toBe(false);
	expect(importTheme(fileOf({ ...custom, text: "#fff" })).ok).toBe(false);
	expect(importTheme(fileOf({ ...custom, bg: { stops: ["#000000"], angle: 180 } })).ok).toBe(false);
	expect(importTheme(fileOf({ ...custom, bg: { stops: ["#000000", "#111111"], angle: "90" } })).ok).toBe(false);
	expect(importTheme(fileOf("dim")).ok).toBe(false);
});

test("import rejects bad font names and path-like slugs", () => {
	const names = ["../../etc", "Roboto;}", "Rоboto", "\u202eRoboto", "Inter</style>", "A".repeat(41)];
	for (const name of names) {
		expect(validateFamily(name)).toBeUndefined();
		const got = importTheme(fileOf({ ...custom, font: { ui: name } }));
		expect(got.ok).toBe(false);
		if (!got.ok) expect(JSON.stringify(got.errors)).not.toContain(name.replace(/"/g, ""));
	}
	expect(familyFromSlug("../etc")).toBeUndefined();
	expect(familyFromSlug("..")).toBeUndefined();
	expect(fontSlug("Inter")).toBe("inter");
});

test("import rejects a media id or a background url", () => {
	expect(importTheme(fileOf({ ...custom, background: { fit: "cover", position: "center", dim: 0, blur: 0, mediaId: "123" } })).ok).toBe(false);
	expect(importTheme(fileOf({ ...custom, background: { url: "https://evil/x.gif" } })).ok).toBe(false);
	expect(importTheme(fileOf({ ...custom, background: "https://evil/x.gif" })).ok).toBe(false);
	expect(importTheme(fileOf({ ...custom, bg: "url(https://evil)" })).ok).toBe(false);
});

test("save rejects a malformed media id", () => {
	const got = parseLookWrite({
		theme: {
			...custom,
			background: { fit: "cover", position: "center", dim: 0, blur: 0, mediaId: "../x" },
		},
	});
	expect(got.ok).toBe(false);
	if (!got.ok) expect(got.errors?.some((e) => e.path === "background.mediaId")).toBe(true);
});

test("page chrome only emits an allowlisted media url", () => {
	const paint = (image: string): BackgroundPaint => ({
		image,
		still: image.startsWith("/media/") ? "/media/poster/123.jpg" : null,
		fit: "cover",
		position: "center",
		dim: 20 as BackgroundPaint["dim"],
		blur: 4 as BackgroundPaint["blur"],
		scale: 100,
		repeat: "repeat",
		panel: 72,
	});
	const css = pageChromeCss(paint("/media/123.png"));
	expect(css).toContain('url("/media/123.png")');
	expect(css).toContain(":not([data-xitter-decor])");
	expect(pageChromeCss(paint("https://evil/x.png"))).toContain("none");
	expect(pageChromeCss(paint("https://evil/x.png"))).not.toContain("evil");
});

test("omitted background scale, repeat, and panel default, and export keeps them off the image", () => {
	const read = sanitiseTheme({
		...custom,
		background: { fit: "tile", position: "center", dim: 0, blur: 0, mediaId: "123" },
	})!.theme;
	expect(read.background).toMatchObject({ scale: 100, repeat: "repeat", panel: 72 });
	const file = exportTheme(read);
	expect(file.theme.background).toEqual({ fit: "tile", position: "center", dim: 0, blur: 0, scale: 100, repeat: "repeat", panel: 72 });
	expect(JSON.stringify(file)).not.toContain("mediaId");
	const imported = importTheme(JSON.stringify(file));
	expect(imported.ok).toBe(true);
	if (!imported.ok) return;
	expect(imported.theme.background).toEqual(file.theme.background);
	expect(imported.theme.background && "mediaId" in imported.theme.background).toBe(false);
	const oldFile = importTheme(fileOf({ ...custom, background: { fit: "cover", position: "bottom", dim: 8, blur: 1 } }));
	expect(oldFile.ok).toBe(true);
	if (!oldFile.ok) return;
	expect(oldFile.theme.background).toEqual({ fit: "cover", position: "bottom", dim: 8, blur: 1, scale: 100, repeat: "repeat", panel: 72 });
});

test("save and import reject bad scale, repeat, and panel", () => {
	const good = { fit: "tile", position: "center", dim: 0, blur: 0, scale: 100, repeat: "repeat", panel: 72 };
	const patches = [
		{ scale: "100" },
		{ scale: 10.5 },
		{ scale: 9 },
		{ scale: 401 },
		{ scale: "10; } body{display:none" },
		{ repeat: "repeat; } body{display:none" },
		{ repeat: "url(https://evil)" },
		{ panel: "72" },
		{ panel: 72.5 },
		{ panel: 19 },
		{ panel: 91 },
		{ rotate: 15 },
		{ extra: true },
	];
	for (const patch of patches) {
		const background = { ...good, ...patch };
		const imported = importTheme(fileOf({ ...custom, background }));
		expect(imported.ok).toBe(false);
		expect(JSON.stringify(imported)).not.toContain("display:none");
		expect(JSON.stringify(imported)).not.toContain("https://evil");
		const saved = parseLookWrite({ theme: { ...custom, background: { ...background, mediaId: "123" } } });
		expect(saved.ok).toBe(false);
		expect(JSON.stringify(saved)).not.toContain("display:none");
		expect(JSON.stringify(saved)).not.toContain("https://evil");
	}
	const ok = importTheme(fileOf({ ...custom, background: { ...good, scale: 150, repeat: "space", panel: 40 } }));
	expect(ok.ok).toBe(true);
	if (!ok.ok) return;
	expect(ok.theme.background).toEqual({ ...good, scale: 150, repeat: "space", panel: 40 });
});

test("page chrome vars match the es5 port and frost rules compose once", () => {
	const base = (over: Partial<BackgroundPaint> = {}): BackgroundPaint => ({
		image: "/media/123.png",
		still: null,
		fit: "cover",
		position: "center",
		dim: 0 as BackgroundPaint["dim"],
		blur: 0 as BackgroundPaint["blur"],
		scale: 100,
		repeat: "repeat",
		panel: 72,
		...over,
	});
	const fits = ["cover", "contain", "tile"] as const;
	const scales = [10, 100, 400];
	const repeats = ["repeat", "space", "round"] as const;
	const images = ["/media/123.png", "/media/9.gif", "/media/poster/4.jpg", "https://evil/x.png"];
	for (const image of images) {
		for (const fit of fits) {
			for (const scale of scales) {
				for (const repeat of repeats) {
					for (const dim of [0, 20]) {
						for (const blur of [0, 8]) {
							for (const panel of [20, 72, 90]) {
								const paint = base({
									image,
									still: image.endsWith(".gif") ? "/media/poster/9.jpg" : null,
									fit,
									scale,
									repeat,
									dim: dim as BackgroundPaint["dim"],
									blur: blur as BackgroundPaint["blur"],
									panel,
									position: scale === 400 ? "top" : "center",
								});
								expect(pageChromeVars(paint)).toEqual(pageChromeVarsEs5(paint));
							}
						}
					}
				}
			}
		}
	}
	const bare = base({ fit: "tile" });
	delete (bare as { scale?: number }).scale;
	delete (bare as { repeat?: BackgroundPaint["repeat"] }).repeat;
	delete (bare as { panel?: number }).panel;
	expect(pageChromeVars(bare)).toEqual(pageChromeVarsEs5(bare));
	expect(pageChromeVars(bare)["--xt-bg-size"]).toBe("auto");
	expect(pageChromeVars(bare)["--xt-bg-repeat"]).toBe("repeat");
	expect(pageChromeVars(bare)["--xt-bg-panel"]).toBe("72%");
	expect(pageChromeVars(base({ fit: "tile", scale: 100, repeat: "space" }))["--xt-bg-size"]).toBe("auto");
	expect(pageChromeVars(base({ fit: "tile", scale: 100, repeat: "space" }))["--xt-bg-repeat"]).toBe("space");
	expect(pageChromeVars(base({ fit: "tile", scale: 40, repeat: "round" }))["--xt-bg-size"]).toBe("40%");
	expect(pageChromeVars(base({ fit: "cover", scale: 100, repeat: "round" }))["--xt-bg-size"]).toBe("cover");
	expect(pageChromeVars(base({ fit: "cover", scale: 100, repeat: "round" }))["--xt-bg-repeat"]).toBe("no-repeat");
	expect(pageChromeVars(base({ fit: "contain", scale: 250 }))["--xt-bg-size"]).toBe("250%");
	expect(pageChromeVars(base({ image: "https://evil/x.png", still: "https://evil/still.png" }))["--xt-bg-image"]).toBe("none");
	expect(pageChromeVars(base({ image: "https://evil/x.png", still: "https://evil/still.png" }))["--xt-bg-still"]).toBe("none");
	expect(pageChromeVars(base({ image: "/media/12.gif", still: "/media/poster/12.jpg" }))["--xt-bg-still"]).toBe('url("/media/poster/12.jpg")');
	expect(pageChromeVars(base({ dim: 20 as BackgroundPaint["dim"], blur: 4 as BackgroundPaint["blur"], panel: 20 }))["--xt-bg-dim"]).toBe("0.2");
	expect(pageChromeVars(base({ dim: 20 as BackgroundPaint["dim"], blur: 4 as BackgroundPaint["blur"], panel: 20 }))["--xt-bg-blur"]).toBe("4px");
	expect(pageChromeVars(base({ panel: 20 }))["--xt-bg-panel"]).toBe("20%");
	const evilRepeat = base({ fit: "tile", repeat: "repeat; } body{display:none" as BackgroundPaint["repeat"] });
	expect(pageChromeVars(evilRepeat)).toEqual(pageChromeVarsEs5(evilRepeat));
	expect(pageChromeVars(evilRepeat)["--xt-bg-repeat"]).toBe("repeat");
	expect(JSON.stringify(pageChromeVars(evilRepeat))).not.toContain("display:none");
	const painted = base({ fit: "tile", scale: 150, repeat: "round", panel: 40, dim: 20 as BackgroundPaint["dim"], blur: 4 as BackgroundPaint["blur"] });
	const vars = pageChromeVars(painted);
	const block = Object.keys(vars)
		.map((k) => `${k}:${vars[k]}`)
		.join(";");
	expect(pageChromeCss(painted)).toBe(`${PAGE_CHROME_SLOTS.root}{${block}}${pageChromeRules(PAGE_CHROME_SLOTS)}`);
	expect(pageChromeCss()).toBe("");
	const css = pageChromeCss(painted);
	expect(css).toContain("-webkit-backdrop-filter:blur(2px)");
	expect(css).toContain("-webkit-backdrop-filter:blur(14px)");
	expect(css).toContain("backdrop-filter:blur(2px)");
	expect(css).toContain("backdrop-filter:blur(14px)");
	expect(css).toContain("@supports not ((-webkit-backdrop-filter:blur(1px)) or (backdrop-filter:blur(1px)))");
	expect(css).toContain("color-mix(in srgb,var(--xt-surface) 92%,transparent)");
	expect(css).toContain("color-mix(in srgb,var(--xt-surface) var(--xt-bg-panel),transparent)");
	expect(css).not.toContain("rotate");
	expect(css).not.toContain("aria-modal");
	expect(bootCss(custom, painted)).toContain("backdrop-filter:blur(14px)");
	const preview = pageChromeRules(PREVIEW_CHROME_SLOTS);
	expect(preview).toContain("#preview.live::before");
	expect(preview).toContain("#preview.live[data-bg] .feed");
	expect(preview).toContain("#preview.live[data-bg] .nav");
	expect(preview).not.toContain("#preview.live[data-bg]::before");
	expect(pageChromeCss(base({ image: "https://evil/x.png" }))).not.toContain("evil");
});

test("theme photos reject wrong magic, oversize, huge frames, and a gif polyglot", () => {
	expect(acceptThemePhoto(PNG_1X1).ok).toBe(true);
	expect(acceptThemePhoto(Buffer.from("<html><script>alert(1)</script>")).ok).toBe(false);
	expect(acceptThemePhoto(gif()).ok).toBe(true);
	const poly = gif({ extra: "</html><script>alert(1)</script>" });
	const polyGot = acceptThemePhoto(poly);
	expect(polyGot.ok).toBe(false);
	if (!polyGot.ok) expect(polyGot.message).not.toContain("script");
	const huge = gif({ width: 4097, height: 4097 });
	expect(acceptThemePhoto(huge).ok).toBe(false);
	const fat = Buffer.concat([PNG_1X1, Buffer.alloc(8 * 1024 * 1024)]);
	expect(acceptThemePhoto(fat).ok).toBe(false);
});
