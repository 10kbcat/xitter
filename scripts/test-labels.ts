import { expect, test } from "bun:test";
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

const slot = (u: User) => (userResult(u).affiliates_highlighted_label as { label?: { userLabelType?: string; description?: string } }).label;

test("automated + parody keeps the slot and hides the parody label", () => {
	const u = { ...blank(), automated_by: "owner", parody_label: "Parody" };
	expect(hiddenLabels(u)).toEqual([{ text: "Parody account", url: `${PUBLIC_ORIGIN}/rules` }]);
	expect(slot(u)?.userLabelType).toBe("AutomatedLabel");
});

test("parody only uses the slot and hides nothing", () => {
	const u = { ...blank(), parody_label: "Parody" };
	expect(hiddenLabels(u)).toEqual([]);
	expect(slot(u)?.description).toBe("Parody account");
});

test("automated + staff label hides the staff text", () => {
	const u = { ...blank(), automated_by: "owner", label: { text: "Staff note", badge_id: null, url: "https://example.com/about" } };
	expect(hiddenLabels(u)).toEqual([{ text: "Staff note", url: "https://example.com/about" }]);
	expect(slot(u)?.userLabelType).toBe("AutomatedLabel");
});

test("a plain account hides nothing", () => {
	expect(hiddenLabels(blank())).toEqual([]);
});
