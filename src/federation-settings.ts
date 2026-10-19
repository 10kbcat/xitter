// Settings > Other instances: hide accounts and organisations from every other
// instance at once, or from some of them (blocks.ts federatedHiddenFor).
// Accounts the viewer follows stay, and searching a full handle
// (@name@example.org) still finds anyone. Kept in users.preferences:
// hide_federated (all of them) and hidden_instances (a list of instance ids).

import { accountPage, esc } from "./account-page";
import type { Viewer } from "./auth";
import { sql } from "./db";
import { ID_RE, INSTANCE_ID, listedInstance, peers } from "./federation";

type Choice = { all: boolean; hidden: string[] };

async function choice(userId: string): Promise<Choice> {
	const [u] = await sql`select preferences->>'hide_federated' = 'true' as hide_all, coalesce(preferences->'hidden_instances', '[]'::jsonb) as hidden from users where id = ${userId}::bigint`;
	const hidden = Array.isArray(u?.hidden) ? u.hidden.filter((i: unknown): i is string => typeof i === "string") : [];
	return { all: !!u?.hide_all, hidden };
}

// the instances on the list, and any other this one has accounts from, with
// how many of their accounts are here
async function instances(hidden: string[]) {
	const counts = await sql`select instance, count(*)::int as accounts from users where instance is not null group by instance`;
	const byId = new Map<string, number>(counts.map((r: any) => [r.instance as string, r.accounts as number]));
	const ids = new Set([...peers().map((p) => p.id), ...byId.keys(), ...hidden]);
	ids.delete(INSTANCE_ID);
	return [...ids].sort().map((id) => ({ id, name: listedInstance(id)?.name ?? null, accounts: byId.get(id) ?? 0 }));
}

const hiddenFor = "they stay out of your timelines, replies, search and suggestions, except accounts you follow";

async function page(req: Request, viewer: Viewer, c: Choice, error = "") {
	const form = (fields: string, label: string, kind = "") =>
		`<form method="post" action="/account/instances" class="inline"><input type="hidden" name="csrf" value="${esc(viewer.csrf)}">${fields}<button type="submit"${kind ? ` class="${kind}"` : ""}>${esc(label)}</button></form>`;
	const list = (await instances(c.hidden))
		.map((i) => {
			const off = c.hidden.includes(i.id);
			const title = i.name && i.name.toLowerCase() !== i.id ? `${esc(i.name)} <span class="meta">${esc(i.id)}</span>` : esc(i.id);
			const meta = `${i.accounts === 1 ? "1 account" : `${i.accounts} accounts`} here${off ? " · hidden" : ""}`;
			return `<div class="card split"><div><b>${title}</b><div class="meta">${meta}</div></div>${form(
				`<input type="hidden" name="instance" value="${esc(i.id)}"><input type="hidden" name="hide" value="${off ? "0" : "1"}">`,
				off ? "Show" : "Hide",
				off ? "small" : "small secondary",
			)}</div>`;
		})
		.join("");
	return accountPage({
		req,
		viewer,
		title: "Other instances",
		status: error ? 400 : 200,
		body: `<h1>Accounts from other instances</h1>
	<p class="dim">${esc(INSTANCE_ID)} shares public accounts and posts with other Xitter instances. ${
		c.all ? `They're all hidden for you now: ${hiddenFor}.` : "Hide all of them, or only the instances you pick below. Hidden, " + hiddenFor + "."
	}</p>
	<p class="dim">You can still find anyone by their full handle, like <b>@name@example.org</b>, in search.</p>
	${error ? `<p class="error">${esc(error)}</p>` : ""}
	${form(`<input type="hidden" name="all" value="${c.all ? "0" : "1"}">`, c.all ? "Show accounts from other instances" : "Hide all other instances")}
	${c.all ? "" : `<h2>Instances</h2>${list || '<p class="dim">No other instances yet.</p>'}`}`,
	});
}

export async function instancesRoute(req: Request, viewer: Viewer): Promise<Response> {
	const c = await choice(viewer.id);
	if (req.method !== "POST") return page(req, viewer, c);
	const f = await req.formData().catch(() => undefined);
	if (String(f?.get("csrf") ?? "") !== viewer.csrf) return page(req, viewer, c, "That form is out of date. Try again.");
	const all = f?.get("all");
	if (all !== null && all !== undefined) {
		await sql`update users set preferences = jsonb_set(coalesce(preferences, '{}'), '{hide_federated}', ${String(all) === "1" ? "true" : "false"}::text::jsonb) where id = ${viewer.id}::bigint`;
	} else {
		const id = String(f?.get("instance") ?? "").toLowerCase();
		if (!ID_RE.test(id) || id === INSTANCE_ID) return page(req, viewer, c, "That isn't an instance.");
		const hide = String(f?.get("hide")) === "1";
		const next = hide ? [...new Set([...c.hidden, id])].slice(-200) : c.hidden.filter((i) => i !== id);
		await sql`update users set preferences = jsonb_set(coalesce(preferences, '{}'), '{hidden_instances}', ${JSON.stringify(next)}::text::jsonb) where id = ${viewer.id}::bigint`;
	}
	return new Response(null, { status: 303, headers: { location: "/account/instances" } });
}
