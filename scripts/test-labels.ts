import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { User } from "../src/auth";
import { PUBLIC_ORIGIN } from "../src/config";
import { hiddenLabels, userResult } from "../src/model";

const blank = (): User => ({
	id: "1",
	screen_name: "bot",
	name: "Bot",
	bio: "",
	location: "",
	avatar_url: null,
	banner_url: null,
	verified_type: null,
	created_at: new Date("2026-01-01"),
});

const slot = (u: User) => (userResult(u).affiliates_highlighted_label as { label?: { userLabelType?: string; description?: string; badge?: { url: string } } }).label;
const maskRe = /\/parody-mask\.\w+\.svg$/;
const expectMask = (icon?: string) => {
	if (icon) expect(icon).toMatch(maskRe);
};

test("automated + parody keeps the slot and hides the parody label", () => {
	const u = { ...blank(), automated_by: "owner", parody_label: "Parody" };
	const [l] = hiddenLabels(u);
	expect(l).toMatchObject({ text: "Parody account", url: `${PUBLIC_ORIGIN}/rules` });
	expectMask(l?.icon);
	expect(slot(u)?.userLabelType).toBe("AutomatedLabel");
});

test("parody only uses the slot and hides nothing", () => {
	const u = { ...blank(), parody_label: "Parody" };
	expect(hiddenLabels(u)).toEqual([]);
	expect(slot(u)?.description).toBe("Parody account");
	expectMask(slot(u)?.badge?.url);
});

test("automated + staff label hides the staff text", () => {
	const u = { ...blank(), automated_by: "owner", label: { text: "Staff note", badge_id: null, url: "https://example.com/about" } };
	const [l] = hiddenLabels(u);
	expect(l).toMatchObject({ text: "Staff note", url: "https://example.com/about" });
	expectMask(l?.icon);
	expect(slot(u)?.userLabelType).toBe("AutomatedLabel");
});

test("automated + staff label with a badge uses the badge png", () => {
	const u = { ...blank(), automated_by: "owner", label: { text: "Staff note", badge_id: "7", url: "https://example.com/about" } };
	expect(hiddenLabels(u)).toEqual([{ text: "Staff note", url: "https://example.com/about", icon: `${PUBLIC_ORIGIN}/public/badge-7.png` }]);
	expect(slot(u)?.userLabelType).toBe("AutomatedLabel");
});

test("a plain account hides nothing", () => {
	expect(hiddenLabels(blank())).toEqual([]);
});

test("the mask name comes from the main bundle when the svg is not on disk", () => {
	const dir = mkdtempSync(join(tmpdir(), "xitter-mask-"));
	mkdirSync(join(dir, "abs", "responsive-web", "client-web"), { recursive: true });
	writeFileSync(join(dir, "build.json"), JSON.stringify({ scripts: ["/responsive-web/client-web/main.deadbeef.js"] }));
	writeFileSync(join(dir, "abs", "responsive-web", "client-web", "main.deadbeef.js"), `s=r.p+"parody-mask.abc123.svg"`);
	const child = Bun.spawnSync({
		cmd: [
			process.execPath,
			"--eval",
			`const { hiddenLabels } = await import(${JSON.stringify(join(import.meta.dir, "../src/model.ts"))});
const [l] = hiddenLabels({
	id: "1", screen_name: "bot", name: "Bot", bio: "", location: "",
	avatar_url: null, banner_url: null, verified_type: null,
	created_at: new Date("2026-01-01"), automated_by: "owner", parody_label: "Parody",
});
if (!l?.icon?.endsWith("/parody-mask.abc123.svg")) {
	console.error(JSON.stringify(l));
	process.exit(1);
}
`,
		],
		env: { ...process.env, CLIENT_DIR: dir },
		stdout: "pipe",
		stderr: "pipe",
	});
	expect(child.exitCode, child.stderr.toString() || child.stdout.toString()).toBe(0);
});
