import { expect, test } from "bun:test";
import { cssUrl, pageChromeVars, type BackgroundPaint } from "../src/themes/css";
import { pageChromeVars as pageChromeVarsEs5 } from "../src/themes/page-chrome-es5.js";
import { type Theme } from "../src/themes/presets";
import { readStoredSteam, steamDefId, STEAM_STILL_PATH, themeWearsSteamFile, type StoredSteam } from "../src/steam-items";
import { commitLook, importResolvedTheme } from "../src/themes/api";
import {
	BACKGROUND_OMITTED,
	STEAM_MISSING,
	exportTheme,
	finishBackground,
	importTheme,
	parseLookWrite,
	sanitiseTheme,
	type BackgroundSource,
} from "../src/themes/validate";
import { DEFAULT_ACCENT } from "../src/themes/presets";

const hex = "a".repeat(40);
const still = `${hex}.png`;
const webm = `${"b".repeat(40)}.webm`;
const mp4 = `${"c".repeat(40)}.mp4`;
const knobs = { fit: "cover" as const, position: "center" as const, dim: 0, blur: 0, scale: 100, repeat: "repeat" as const, panel: 72 };

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

function stored(): StoredSteam {
	const steam = readStoredSteam({ appid: 753, defid: 190993, image: still, movie: webm, mp4 });
	if (!steam) throw new Error("fixture steam");
	return steam;
}

const none: BackgroundSource = { tag: "none" };

test("save and import reject client steam files and bad defids", () => {
	const extras = ["appid", "image", "movie", "mp4", "name"] as const;
	for (const key of extras) {
		const background = { ...knobs, steam: { defid: 190993, [key]: key === "appid" ? 753 : "nope" } };
		const saved = parseLookWrite({ theme: { ...custom, background } });
		expect(saved.ok).toBe(false);
		if (!saved.ok) expect(saved.errors?.some((e) => e.message === "unknown key")).toBe(true);
		const imported = importTheme(fileOf({ ...custom, background }));
		expect(imported.ok).toBe(false);
		if (!imported.ok) expect(imported.errors.some((e) => e.message === "unknown key")).toBe(true);
	}
	for (const defid of ["../1", "", 0, 1.5, null, "1234567890123", "nope", "1;}body{display:none"]) {
		const background = { ...knobs, steam: { defid } };
		const saved = parseLookWrite({ theme: { ...custom, background } });
		expect(saved.ok).toBe(false);
		if (!saved.ok) expect(saved.errors?.some((e) => e.message === "invalid steam background")).toBe(true);
		expect(importTheme(fileOf({ ...custom, background })).ok).toBe(false);
	}
	const both = parseLookWrite({ theme: { ...custom, background: { ...knobs, mediaId: "123", steam: { defid: 12 } } } });
	expect(both.ok).toBe(false);
	if (!both.ok) expect(both.errors?.some((e) => e.message === "background has two sources")).toBe(true);
	for (const key of ["mediaId", "url", "src", "href"]) {
		const background = { ...knobs, steam: { defid: 12, [key]: "1" } };
		expect(importTheme(fileOf({ ...custom, background })).ok).toBe(false);
	}
});

test("read drops a bad steam source and keeps the knobs", () => {
	const webmImage = sanitiseTheme({ ...custom, background: { ...knobs, steam: { appid: 753, defid: 12, image: webm } } });
	expect(webmImage?.theme.background?.fit).toBe("cover");
	expect(webmImage?.theme.background && "steam" in webmImage.theme.background && webmImage.theme.background.steam).toBeFalsy();
	const badMovie = sanitiseTheme({ ...custom, background: { ...knobs, steam: { appid: 753, defid: 12, image: still, movie: still } } });
	expect(badMovie?.theme.background && "steam" in badMovie.theme.background ? badMovie.theme.background.steam?.movie : "missing").toBeUndefined();
	expect(badMovie?.theme.background && "steam" in badMovie.theme.background ? badMovie.theme.background.steam?.image : "").toBe(still);
	const badMp4 = sanitiseTheme({ ...custom, background: { ...knobs, steam: { appid: 753, defid: 12, image: still, mp4: webm } } });
	expect(badMp4?.theme.background && "steam" in badMp4.theme.background ? badMp4.theme.background.steam?.mp4 : "missing").toBeUndefined();
	const stringApp = sanitiseTheme({ ...custom, background: { ...knobs, steam: { appid: "753", defid: 12, image: still } } });
	expect(stringApp?.theme.background && "steam" in stringApp.theme.background && stringApp.theme.background.steam).toBeFalsy();
	const traversal = sanitiseTheme({ ...custom, background: { ...knobs, steam: { appid: 753, defid: 12, image: "../x.png" } } });
	expect(traversal?.theme.background && "steam" in traversal.theme.background && traversal.theme.background.steam).toBeFalsy();
	const remote = sanitiseTheme({ ...custom, background: { ...knobs, steam: { appid: 753, defid: 12, image: "https://evil.example/x.png" } } });
	expect(remote?.theme.background && "steam" in remote.theme.background && remote.theme.background.steam).toBeFalsy();
	const scripted = sanitiseTheme({ ...custom, background: { ...knobs, steam: { appid: 753, defid: 12, image: "javascript:alert(1)" } } });
	expect(scripted?.theme.background && "steam" in scripted.theme.background && scripted.theme.background.steam).toBeFalsy();
	const both = sanitiseTheme({ ...custom, background: { ...knobs, mediaId: "123", steam: { appid: 753, defid: 12, image: still } } });
	expect(both?.theme.background?.fit).toBe("cover");
	expect(both?.theme.background && "mediaId" in both.theme.background && both.theme.background.mediaId).toBeFalsy();
	expect(both?.theme.background && "steam" in both.theme.background && both.theme.background.steam).toBeFalsy();
	const named = sanitiseTheme({ ...custom, background: { ...knobs, steam: { appid: 753, defid: 12, image: still, name: "nope" } } });
	const steam = named?.theme.background && "steam" in named.theme.background ? named.theme.background.steam : undefined;
	expect(steam?.image).toBe(still);
	expect(steam && "name" in steam).toBe(false);
	const polluted = JSON.parse(`{"id":"custom","base":"dark","bg":{"stops":["#000000","#111111"],"angle":180},"surface":"#111111","text":"#ffffff","accent":"#1d9bf0","button":{"stops":["#ffffff","#eeeeee"],"angle":180},"buttonText":"#000000","background":{"fit":"cover","position":"center","dim":0,"blur":0,"scale":100,"repeat":"repeat","panel":72,"steam":{"__proto__":{"admin":true},"appid":753,"defid":12,"image":"${still}"}}}`);
	const clean = sanitiseTheme(polluted);
	expect(clean?.theme.background && "steam" in clean.theme.background ? clean.theme.background.steam?.defid : 0).toBe(12);
	expect(JSON.stringify(clean?.theme.background)).not.toContain("admin");
});

function frameOf(dim: number) {
	const parsed = parseLookWrite({ theme: { ...custom, background: { ...knobs, dim } } });
	if (!parsed.ok || parsed.write.type !== "paint" || !parsed.write.theme.background) throw new Error("frame");
	return parsed.write.theme;
}

test("export and peel carry a defid and one source", () => {
	const steam = stored();
	const theme = sanitiseTheme({ ...custom, background: { ...knobs, steam: { appid: 753, defid: 190993, image: still, movie: webm } } })!.theme;
	const file = exportTheme(theme);
	expect(file.theme.background?.steam).toEqual({ defid: 190993 });
	expect(JSON.stringify(file)).not.toContain(still);
	const kept = finishBackground(theme, frameOf(40), "frame", none, undefined);
	expect(kept.ok && kept.theme.background && "steam" in kept.theme.background && kept.theme.background.steam?.image).toBe(still);
	expect(kept.ok && kept.theme.background?.dim).toBe(40);
	const upload = sanitiseTheme({ ...custom, background: { ...knobs, mediaId: "123" } })!.theme.background;
	if (!upload || !("mediaId" in upload) || !upload.mediaId) throw new Error("media");
	const uploaded = finishBackground(theme, frameOf(0), "frame", { tag: "upload", mediaId: upload.mediaId }, undefined);
	expect(uploaded.ok && uploaded.theme.background && "mediaId" in uploaded.theme.background && uploaded.theme.background.mediaId).toBe("123");
	expect(uploaded.ok && uploaded.theme.background && "steam" in uploaded.theme.background && uploaded.theme.background.steam).toBeFalsy();
	const previousUpload = sanitiseTheme({ ...custom, background: { ...knobs, mediaId: "123" } })!.theme;
	const defid = steamDefId(190993);
	if (!defid) throw new Error("defid");
	const replaced = finishBackground(previousUpload, frameOf(0), "frame", { tag: "steam", defid }, steam);
	expect(replaced.ok && replaced.theme.background && "steam" in replaced.theme.background && replaced.theme.background.steam?.defid).toBe(190993);
	expect(replaced.ok && replaced.theme.background && "mediaId" in replaced.theme.background && replaced.theme.background.mediaId).toBeFalsy();
	const dim = parseLookWrite({ theme: { id: "dim" } });
	if (!dim.ok || dim.write.type !== "paint") throw new Error("dim");
	const preset = finishBackground(theme, dim.write.theme, dim.write.peel, dim.write.source, undefined);
	expect(preset.ok && preset.theme.background).toBeUndefined();
	const missing = finishBackground(undefined, frameOf(0), "frame", { tag: "steam", defid }, undefined);
	expect(missing.ok).toBe(false);
	if (!missing.ok) expect(missing.error).toBe(STEAM_MISSING);
});

test("worn matches only the three stored steam filenames", () => {
	const prefs = { theme: { background: { steam: { appid: 753, defid: 12, image: still, movie: webm, mp4 } }, font: { ui: still } }, accent: still };
	expect(themeWearsSteamFile(prefs, still)).toBe(true);
	expect(themeWearsSteamFile(prefs, webm)).toBe(true);
	expect(themeWearsSteamFile(prefs, mp4)).toBe(true);
	expect(themeWearsSteamFile(prefs, `${hex}.jpg`)).toBe(false);
	expect(themeWearsSteamFile({ theme: { background: { steam: { image: `prefix${still}` } } } }, still)).toBe(false);
	expect(themeWearsSteamFile({ decor: { background: { image: still } } }, still)).toBe(false);
	expect(themeWearsSteamFile({ theme: { background: { mediaId: "1" } } }, still)).toBe(false);
});

test("cssUrl allows a steam still and refuses video and foreign urls", () => {
	const path = `/public/steam/753/${still}`;
	expect(cssUrl(path)).toBe(`url("${path}")`);
	expect(cssUrl(`${path}?thumb=1`)).toBe("none");
	expect(cssUrl(`/public/steam/753/${webm}`)).toBe("none");
	expect(cssUrl("https://evil/x.png")).toBe("none");
	expect(cssUrl(`/public/steam/753/${"A".repeat(40)}.png`)).toBe("none");
	expect(cssUrl("javascript:alert(1)")).toBe("none");
	expect(cssUrl(`/public/steam/../753/${still}`)).toBe("none");
	const paint = (image: string): BackgroundPaint => ({
		image,
		still: image,
		fit: "cover",
		position: "center",
		dim: 0 as BackgroundPaint["dim"],
		blur: 0 as BackgroundPaint["blur"],
		scale: 100,
		repeat: "repeat",
		panel: 72,
		movie: null,
		mp4: null,
		defid: null,
	});
	expect(pageChromeVars(paint(path))).toEqual(pageChromeVarsEs5(paint(path)));
	expect(pageChromeVars(paint(`/public/steam/753/${webm}`))["--xt-bg-image"]).toBe("none");
	expect(STEAM_STILL_PATH.test(path)).toBe(true);
});

test("import resolver reports a miss and keeps the defid off the filenames", async () => {
	const text = fileOf({ ...custom, background: { ...knobs, steam: { defid: 190993 } } });
	const missed = await importResolvedTheme(text, async () => undefined);
	expect(missed.ok).toBe(false);
	if (!missed.ok) {
		expect(missed.errors[0]?.path).toBe("theme.background.steam");
		expect(missed.errors[0]?.message).toBe(STEAM_MISSING);
	}
	const hit = await importResolvedTheme(text, async () => stored());
	expect(hit.ok).toBe(true);
	if (!hit.ok) return;
	expect(hit.preview?.image).toMatch(STEAM_STILL_PATH);
	expect(JSON.stringify(hit.theme)).toContain("190993");
	expect(JSON.stringify(hit.theme)).not.toContain(still);
	const sliders = importTheme(fileOf({ ...custom, background: knobs }));
	expect(sliders.ok && sliders.warnings.includes(BACKGROUND_OMITTED)).toBe(true);
});

test("an unchanged defid does not ask Steam again", async () => {
	const theme = sanitiseTheme({ ...custom, background: { ...knobs, steam: { appid: 753, defid: 190993, image: still } } })!.theme;
	const parsed = parseLookWrite({ theme: { ...custom, background: { ...knobs, dim: 10, steam: { defid: 190993 } } } });
	expect(parsed.ok).toBe(true);
	if (!parsed.ok) return;
	let calls = 0;
	const saved = await commitLook("0", { look: { kind: "painted", theme }, accent: DEFAULT_ACCENT }, parsed.write, undefined, [], async () => {
		calls += 1;
		return undefined;
	});
	expect(calls).toBe(0);
	expect(saved.ok).toBe(true);
	if (saved.ok && saved.look?.kind === "painted") {
		const bg = saved.look.theme.background;
		expect(bg && "steam" in bg ? bg.steam?.image : "").toBe(still);
		expect(bg?.dim).toBe(10);
	}
});

test.skipIf(!process.env.STEAM_THEME_LIVE)("live import defid 190993", async () => {
	const text = fileOf({ ...custom, background: { ...knobs, steam: { defid: 190993 } } });
	const result = await importResolvedTheme(text);
	expect(result.ok).toBe(true);
});
