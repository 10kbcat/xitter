// Settings > Other instances: one switch that hides accounts and organisations
// from other instances (blocks.ts federatedHiddenFor). Accounts the viewer
// follows stay, and searching a full handle (@name@example.org) still finds
// anyone. Kept in users.preferences.hide_federated.

import { accountPage, esc } from "./account-page";
import type { Viewer } from "./auth";
import { sql } from "./db";
import { INSTANCE_ID } from "./federation";

async function hidden(userId: string): Promise<boolean> {
	const [u] = await sql`select preferences->>'hide_federated' = 'true' as on from users where id = ${userId}::bigint`;
	return !!u?.on;
}

function page(req: Request, viewer: Viewer, on: boolean, error = "") {
	return accountPage({
		req,
		viewer,
		title: "Other instances",
		status: error ? 400 : 200,
		body: `<form method="post" action="/account/instances">
	<h1>Accounts from other instances</h1>
	<p class="dim">${esc(INSTANCE_ID)} shares public accounts and posts with other Xitter instances. ${
		on
			? "They're hidden for you now: they stay out of your timelines, replies, search and suggestions, except accounts you follow."
			: "They show up in your timelines, replies, search and suggestions like accounts from here."
	}</p>
	<p class="dim">You can still find anyone by their full handle, like <b>@name@example.org</b>, in search.</p>
	${error ? `<p class="error">${esc(error)}</p>` : ""}
	<input type="hidden" name="csrf" value="${esc(viewer.csrf)}">
	<input type="hidden" name="hide" value="${on ? "0" : "1"}">
	<button type="submit">${on ? "Show accounts from other instances" : "Hide accounts from other instances"}</button>
</form>`,
	});
}

export async function instancesRoute(req: Request, viewer: Viewer): Promise<Response> {
	if (req.method !== "POST") return page(req, viewer, await hidden(viewer.id));
	const f = await req.formData().catch(() => undefined);
	if (String(f?.get("csrf") ?? "") !== viewer.csrf) return page(req, viewer, await hidden(viewer.id), "That form is out of date. Try again.");
	const on = String(f?.get("hide")) === "1";
	await sql`update users set preferences = jsonb_set(coalesce(preferences, '{}'), '{hide_federated}', ${on ? "true" : "false"}::text::jsonb) where id = ${viewer.id}::bigint`;
	return new Response(null, { status: 303, headers: { location: "/account/instances" } });
}
