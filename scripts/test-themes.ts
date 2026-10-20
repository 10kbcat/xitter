import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	PRESETS,
	SWATCH_IDS,
	contrast,
	derived,
	deriveTokens,
	mixHex,
	parseHex,
	sanitiseTheme,
} from "../src/themes";
import {
	ensureFont,
	fontCss,
	fontSlug,
	parseFontCss,
	resetFontState,
	validateFamily,
} from "../src/fonts";

test("hex colours are normalised", () => {
	expect(parseHex("#15202B")).toBe("#15202b");
	expect(parseHex("#abc")).toBe("#aabbcc");
	expect(parseHex("red")).toBeUndefined();
	expect(parseHex("#gggggg")).toBeUndefined();
	expect(parseHex("#11223344")).toBeUndefined();
});

test("sanitising rejects bad colours, angles and too many stops", () => {
	expect(sanitiseTheme(null)).toBeNull();
	expect(sanitiseTheme("dim")).toBeNull();
	expect(sanitiseTheme({ id: "custom", base: "dark" })).toBeNull();
	expect(
		sanitiseTheme({
			id: "custom",
			base: "dark",
			bg: { stops: ["red"], angle: 90 },
			surface: "#111111",
			text: "#ffffff",
			accent: "#1d9bf0",
			button: { stops: ["#ffffff"], angle: 90 },
			buttonText: "#000000",
		}),
	).toBeNull();
	expect(
		sanitiseTheme({
			id: "custom",
			base: "dark",
			bg: { stops: ["#000"], angle: 400 },
			surface: "#111111",
			text: "#ffffff",
			accent: "#1d9bf0",
			button: { stops: ["#ffffff"], angle: 90 },
			buttonText: "#000000",
		}),
	).toBeNull();
	expect(
		sanitiseTheme({
			id: "custom",
			base: "dark",
			bg: { stops: ["#000"], angle: 1.5 },
			surface: "#111111",
			text: "#ffffff",
			accent: "#1d9bf0",
			button: { stops: ["#ffffff"], angle: 90 },
			buttonText: "#000000",
		}),
	).toBeNull();
	expect(
		sanitiseTheme({
			id: "custom",
			base: "dark",
			bg: { stops: ["#111", "#222", "#333", "#444", "#555", "#666"], angle: 90 },
			surface: "#111111",
			text: "#ffffff",
			accent: "#1d9bf0",
			button: { stops: ["#ffffff"], angle: 90 },
			buttonText: "#000000",
		}),
	).toBeNull();
});

test("unknown keys are dropped", () => {
	const got = sanitiseTheme({ id: "dim", extra: true, nested: { a: 1 } });
	expect(got?.theme).toEqual(PRESETS.dim);
	expect(got && "extra" in got.theme).toBe(false);
});

test("dim preset is X's dim", () => {
	expect(PRESETS.dim.bg.stops[0]).toBe("#15202b");
	expect(PRESETS.dim.surface).toBe("#1e2732");
	expect(PRESETS.dim.text).toBe("#f7f9f9");
	expect(PRESETS.dim.base).toBe("dark");
	expect(sanitiseTheme({ id: "dim" })?.theme).toEqual(PRESETS.dim);
});

test("contrast clamping replaces unreadable text and button text", () => {
	const got = sanitiseTheme({
		id: "custom",
		base: "dark",
		bg: { stops: ["#0a0a12", "#180828"], angle: 120 },
		surface: "#121018",
		text: "#000000",
		accent: "#1d9bf0",
		button: { stops: ["#ffffff"], angle: 180 },
		buttonText: "#ffffff",
		noise: "nope",
	});
	expect(got).not.toBeNull();
	expect(got!.theme.text).toBe("#ffffff");
	expect(got!.theme.buttonText).toBe("#0f1419");
	expect(got!.theme.id).toBe("custom");
	expect("noise" in got!.theme).toBe(false);
	expect(got!.warnings.length).toBeGreaterThan(0);
});

test("warnings under 4.5:1 without clamping at 3:1", () => {
	const got = sanitiseTheme({
		id: "custom",
		base: "dark",
		bg: { stops: ["#000000"], angle: 180 },
		surface: "#000000",
		text: "#6a6a6a",
		accent: "#1d9bf0",
		button: { stops: ["#ffffff"], angle: 180 },
		buttonText: "#8a8a8a",
	});
	expect(got).not.toBeNull();
	expect(contrast("#6a6a6a", "#000000")).toBeGreaterThanOrEqual(3);
	expect(contrast("#6a6a6a", "#000000")).toBeLessThan(4.5);
	expect(got!.theme.text).toBe("#6a6a6a");
	expect(got!.warnings.some((w) => w.includes("text on #000000"))).toBe(true);
});

test("advanced fields sanitise: whitelist, gradients only on allowed fields, bad values dropped", () => {
	const got = sanitiseTheme({
		id: "custom",
		base: "dark",
		bg: { stops: ["#0a0a12"], angle: 180 },
		surface: { stops: ["#121018", "#1a1020"], angle: 90 },
		text: "#ffffff",
		accent: "#1d9bf0",
		button: { stops: ["#ffffff"], angle: 180 },
		buttonText: "#000000",
		muted: { stops: ["#111111"], angle: 90 },
		link: "javascript:alert(1)",
		border: "#334455",
		reply: "#ff8800",
		font: { ui: "Inter", display: "</style>" },
		onerror: "alert(1)",
		header: { stops: ["#111111", "#222222"], angle: 45 },
	});
	expect(got).not.toBeNull();
	expect(got!.theme.border).toBe("#334455");
	expect(got!.theme.reply).toBe("#ff8800");
	expect(got!.theme.muted).toBeUndefined();
	expect(got!.theme.link).toBeUndefined();
	expect(typeof got!.theme.surface).toBe("object");
	expect((got!.theme.surface as { stops: string[] }).stops).toEqual(["#121018", "#1a1020"]);
	expect(got!.theme.header).toEqual({ stops: ["#111111", "#222222"], angle: 45 });
	expect(got!.theme.font).toEqual({ ui: "Inter" });
	expect("onerror" in got!.theme).toBe(false);
});

test("derived defaults for unset advanced fields", () => {
	const got = sanitiseTheme({
		id: "custom",
		base: "dark",
		bg: { stops: ["#000000"], angle: 180 },
		surface: "#111111",
		text: "#ffffff",
		accent: "#1d9bf0",
		button: { stops: ["#ffffff"], angle: 180 },
		buttonText: "#000000",
	});
	expect(got).not.toBeNull();
	const d = derived(got!.theme);
	expect(d.muted).toBe(mixHex("#ffffff", "#000000", 0.45));
	expect(d.border).toBe(mixHex("#ffffff", "#000000", 0.82));
	expect(d.link).toBe("#1d9bf0");
	expect(d.reply).toBe("#1d9bf0");
	expect(d.like).toBe("#f91880");
	expect(d.repost).toBe("#00ba7c");
	expect(got!.theme.muted).toBeUndefined();
});

test("contrast clamping for advanced text fields", () => {
	const got = sanitiseTheme({
		id: "custom",
		base: "dark",
		bg: { stops: ["#000000"], angle: 180 },
		surface: "#000000",
		text: "#ffffff",
		accent: "#1d9bf0",
		button: { stops: ["#ffffff"], angle: 180 },
		buttonText: "#000000",
		muted: "#050505",
		link: "#000000",
		secondary: "#010101",
		inputBg: "#ffffff",
		inputText: "#ffffff",
	});
	expect(got).not.toBeNull();
	expect(got!.theme.muted).toBe("#ffffff");
	expect(got!.theme.link).toBe("#ffffff");
	expect(got!.theme.secondary).toBe("#ffffff");
	expect(got!.theme.inputText).toBe("#0f1419");
	expect(got!.warnings.some((w) => w.includes("muted text"))).toBe(true);
	expect(got!.warnings.some((w) => w.includes("link"))).toBe(true);
});

test("every preset passes 4.5:1 including Ember's link", () => {
	for (const id of ["dim", ...SWATCH_IDS]) {
		const p = PRESETS[id]!;
		const d = derived(p);
		const bgs = [...p.bg.stops, typeof p.surface === "string" ? p.surface : p.surface.stops[0]!];
		for (const bg of bgs) expect(contrast(p.text, bg), `${id} text on ${bg}`).toBeGreaterThanOrEqual(4.5);
		for (const bg of bgs) expect(contrast(d.link, bg), `${id} link on ${bg}`).toBeGreaterThanOrEqual(4.5);
		for (const stop of p.button.stops) expect(contrast(p.buttonText, stop), `${id} button on ${stop}`).toBeGreaterThanOrEqual(4.5);
		expect(sanitiseTheme({ id })?.warnings ?? ["x"]).toEqual([]);
	}
	expect(PRESETS.ember.link ?? PRESETS.ember.accent).not.toBe("#1d9bf0");
	expect(PRESETS.ember.accent).toBe("#ffb020");
});

test("derived tokens", () => {
	const dim = derived(PRESETS.dim);
	expect(dim.bg).toBe("#15202b");
	expect(dim.muted).toBe("#8b98a5");
	expect(dim.border).toBe("#38444d");
	expect(dim.surface).toBe("#1e2732");
	const mid = derived(PRESETS.midnight);
	expect(mid.bg).toContain("linear-gradient");
	expect(mid.text).toBe(PRESETS.midnight.text);
	expect(mid.surface).toBe(PRESETS.midnight.surface);
	expect(mid.accent).toBe(PRESETS.midnight.accent);
	expect(PRESETS.rose.base).toBe("light");
	expect(deriveTokens(PRESETS.rose).scheme).toBe("light");
	expect(deriveTokens(PRESETS.rose).logo).toContain("logo-light");
});

test("font family validation", () => {
	expect(validateFamily("Inter")).toBe("Inter");
	expect(validateFamily("Source Sans 3")).toBe("Source Sans 3");
	expect(validateFamily("  IBM  Plex  Sans ")).toBe("IBM Plex Sans");
	expect(validateFamily("Press Start 2P")).toBe("Press Start 2P");
	expect(validateFamily("")).toBeUndefined();
	expect(validateFamily('Inter";}')).toBeUndefined();
	expect(validateFamily("Inter;")).toBeUndefined();
	expect(validateFamily("Inter{")).toBeUndefined();
	expect(validateFamily("url(https://x)")).toBeUndefined();
	expect(validateFamily("</style>")).toBeUndefined();
	expect(validateFamily("A".repeat(41))).toBeUndefined();
	expect(fontSlug("Source Sans 3")).toBe("source-sans-3");
});

const SAMPLE_CSS = `
/* cyrillic */
@font-face {
  font-family: 'Inter';
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url(https://fonts.gstatic.com/s/inter/v18/cyrillic.woff2) format('woff2');
  unicode-range: U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116;
}
/* latin-ext */
@font-face {
  font-family: 'Inter';
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url(https://fonts.gstatic.com/s/inter/v18/latin-ext.woff2) format('woff2');
  unicode-range: U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF;
}
/* latin */
@font-face {
  font-family: 'Inter';
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url(https://fonts.gstatic.com/s/inter/v18/latin.woff2) format('woff2');
  unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
}
/* latin italic */
@font-face {
  font-family: 'Inter';
  font-style: italic;
  font-weight: 400;
  font-display: swap;
  src: url(https://fonts.gstatic.com/s/inter/v18/latin-italic.woff2) format('woff2');
  unicode-range: U+0000-00FF;
}
@font-face {
  font-family: 'Evil';
  font-style: normal;
  font-weight: 400;
  src: url(https://evil.example/x.woff2) format('woff2');
  unicode-range: U+0000-00FF;
}
@font-face {
  font-family: 'Weird';
  font-style: normal;
  font-weight: 400;
  src: url(https://fonts.gstatic.com/s/weird/v1/x.ttf) format('truetype');
  unicode-range: U+0000-00FF;
}
`;

test("google css2 parser keeps only safe latin faces", () => {
	const faces = parseFontCss(SAMPLE_CSS);
	expect(faces.map((f) => `${f.weight}-${f.subset}`).sort()).toEqual(["400-latin", "400-latin-ext"]);
	expect(faces.every((f) => f.url.startsWith("https://fonts.gstatic.com/"))).toBe(true);
	const css = fontCss("Inter", "inter", faces);
	expect(css).toContain('font-family:"Inter"');
	expect(css).toContain("/i/xitter/fonts/inter/400-latin.woff2");
	expect(css).toContain("/i/xitter/fonts/inter/400-latin-ext.woff2");
	expect(css).not.toContain("evil");
	expect(css).not.toContain("gstatic.com");
	expect(css).not.toContain("</style>");
	expect(css).not.toContain("Evil");
});

const dir = mkdtempSync(join(tmpdir(), "xitter-fonts-"));

test("fonts download, cache, share, refuse bad files, and remember failures", async () => {
	const prevMedia = process.env.MEDIA_DIR;
	const prevCss = process.env.GOOGLE_FONTS_CSS_ORIGIN;
	const prevFile = process.env.GOOGLE_FONTS_FILE_ORIGIN;
	process.env.MEDIA_DIR = dir;
	resetFontState();
	const hits: string[] = [];
	const woff = Buffer.concat([Buffer.from("wOF2"), Buffer.alloc(64, 1)]);
	const huge = Buffer.concat([Buffer.from("wOF2"), Buffer.alloc(2 * 1024 * 1024 + 8, 2)]);
	const fake = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(req) {
			const u = new URL(req.url);
			hits.push(u.pathname);
			if (u.pathname === "/css2") {
				const family = u.searchParams.get("family") ?? "";
				if (family.startsWith("Missing")) return new Response("nope", { status: 404 });
				const file =
					family.startsWith("Oversized") ? "/huge.woff2" : family.startsWith("NotWoff") ? "/plain.woff2" : "/ok.woff2";
				const origin = u.origin;
				return new Response(
					`@font-face{font-family:'X';font-style:normal;font-weight:400;src:url(${origin}${file}) format('woff2');unicode-range:U+0000-00FF;}`,
					{ headers: { "content-type": "text/css" } },
				);
			}
			if (u.pathname === "/ok.woff2") return new Response(woff, { headers: { "content-type": "font/woff2" } });
			if (u.pathname === "/huge.woff2") return new Response(huge, { headers: { "content-type": "font/woff2" } });
			if (u.pathname === "/plain.woff2") return new Response("not a font", { headers: { "content-type": "font/woff2" } });
			return new Response("no", { status: 404 });
		},
	});
	const origin = `http://127.0.0.1:${fake.port}`;
	process.env.GOOGLE_FONTS_CSS_ORIGIN = origin;
	process.env.GOOGLE_FONTS_FILE_ORIGIN = origin;
	try {
		const first = await ensureFont("Cache Font");
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		expect(first.slug).toBe("cache-font");
		const cssPath = join(dir, "fonts", "cache-font", "fonts.css");
		const css = readFileSync(cssPath, "utf8");
		expect(css).toContain('font-family:"Cache Font"');
		expect(css).toContain("/i/xitter/fonts/cache-font/400-latin.woff2");
		expect(existsWoff("cache-font")).toBe(true);
		const cssHits = hits.filter((p) => p === "/css2").length;
		const second = await ensureFont("Cache Font");
		expect(second.ok).toBe(true);
		expect(hits.filter((p) => p === "/css2").length).toBe(cssHits);

		resetFontState();
		const before = hits.length;
		const many = await Promise.all([ensureFont("Same Time"), ensureFont("Same Time"), ensureFont("Same Time")]);
		expect(many.every((r) => r.ok)).toBe(true);
		expect(hits.filter((p) => p === "/css2").length - hits.slice(0, before).filter((p) => p === "/css2").length).toBe(1);

		resetFontState();
		const big = await ensureFont("Oversized");
		expect(big.ok).toBe(false);
		const not = await ensureFont("NotWoff");
		expect(not.ok).toBe(false);

		resetFontState();
		const n = hits.length;
		const miss = await ensureFont("Missing");
		expect(miss.ok).toBe(false);
		const miss2 = await ensureFont("Missing");
		expect(miss2.ok).toBe(false);
		expect(hits.length).toBe(n + 1);
	} finally {
		fake.stop(true);
		if (prevMedia === undefined) delete process.env.MEDIA_DIR;
		else process.env.MEDIA_DIR = prevMedia;
		if (prevCss === undefined) delete process.env.GOOGLE_FONTS_CSS_ORIGIN;
		else process.env.GOOGLE_FONTS_CSS_ORIGIN = prevCss;
		if (prevFile === undefined) delete process.env.GOOGLE_FONTS_FILE_ORIGIN;
		else process.env.GOOGLE_FONTS_FILE_ORIGIN = prevFile;
	}
});

function existsWoff(slug: string) {
	try {
		return readFileSync(join(dir, "fonts", slug, "400-latin.woff2")).subarray(0, 4).toString() === "wOF2";
	} catch {
		return false;
	}
}

afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});
