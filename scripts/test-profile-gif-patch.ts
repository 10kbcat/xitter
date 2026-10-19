import { expect, test } from "bun:test";
import { patchText } from "../src/patch";

test("profile image pickers accept GIFs without changing other pickers", () => {
	const input = [
		"{location:T.rz.Avatar,mediaItem:avatar,onChange:change}",
		"{location:T.rz.ProfileBanner,mediaItem:banner,onChange:change}",
		"{location:T.rz.Post,mediaItem:post,onChange:change}",
	].join(";");
	const patched = patchText(input);
	expect(patched).toContain("acceptGifs:!0,location:T.rz.Avatar,mediaItem:avatar");
	expect(patched).toContain("acceptGifs:!0,location:T.rz.ProfileBanner,mediaItem:banner");
	expect(patched).toContain("{location:T.rz.Post,mediaItem:post");
});
