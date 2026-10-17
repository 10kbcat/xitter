// /account/organisation: an organisation (a gold-badge account) and the
// affiliates it makes managers add and remove its affiliates. Being added puts
// the organisation's badge on a profile, so it is a request the account
// accepts here first; the request shows in its notifications (notifications.ts).
// Staff still add affiliates directly from the admin panel.

import type { Viewer } from "./auth";
import { sql } from "./db";
import { settings } from "./settings";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const page = (body: string, status = 200) =>
	new Response(
		`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Organisation · ${esc(settings().instance_name)}</title>
<style>body{margin:0;background:#000;color:#e7e9ea;font:16px/1.45 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh}
main{width:min(560px,92vw);padding:24px 0}h1{font-size:26px;margin:0 0 12px}h2{font-size:19px;margin:24px 0 8px}
input,button{box-sizing:border-box;padding:10px 14px;border-radius:8px;font:inherit}input{background:#000;border:1px solid #333;color:inherit;flex:1}
button{background:#eff3f4;color:#0f1419;border:0;font-weight:700;cursor:pointer}button.quiet{background:#16181c;color:#e7e9ea;font-weight:400}button.danger{background:#f4212e;color:#fff}
form{display:inline}form.row,.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.person{display:flex;justify-content:space-between;align-items:center;gap:8px;background:#16181c;border-radius:8px;padding:10px 14px;margin:6px 0}
.err{color:#f4212e}.dim{color:#71767b;font-size:14px}a{color:#1d9bf0}</style></head>
<body><main>${body}<p><a href="/home">Back to ${esc(settings().instance_name)}</a></p></main></body></html>`,
		{ status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" } },
	);

type Org = { id: string; screen_name: string; name: string; self: boolean };

// the organisation this account runs: itself, or the one it manages
async function managedOrg(viewer: Viewer): Promise<Org | undefined> {
	const [org] = await sql`select u.id::text, u.screen_name, u.name, u.id = ${viewer.id}::bigint as self from users u
		where u.verified_type = 'business' and (u.id = ${viewer.id}::bigint
			or u.id = (select org_id from affiliations where user_id = ${viewer.id}::bigint and manager))`;
	return org as Org | undefined;
}

const form = (action: string, fields: Record<string, string>, label: string, cls = "quiet") =>
	`<form method="post"><input type="hidden" name="do" value="${action}">${Object.entries(fields)
		.map(([k, v]) => `<input type="hidden" name="${k}" value="${esc(v)}">`)
		.join("")}<button class="${cls}">${label}</button></form>`;

async function view(viewer: Viewer, error = "", notice = "") {
	const org = await managedOrg(viewer);
	const [mine] = await sql`select o.screen_name, a.manager from affiliations a join users o on o.id = a.org_id where a.user_id = ${viewer.id}::bigint`;
	const asked = await sql`select o.id::text, o.screen_name, o.name from affiliation_requests r join users o on o.id = r.org_id
		where r.user_id = ${viewer.id}::bigint and o.verified_type = 'business' order by r.created_at`;
	let body = `<h1>Organisation</h1>${notice ? `<p>${esc(notice)}</p>` : ""}${error ? `<p class="err">${esc(error)}</p>` : ""}`;

	if (asked.length)
		body += `<h2>Requests for you</h2>${asked
			.map(
				(o: any) => `<div class="person"><span><b>${esc(o.name)}</b> <a href="/${esc(o.screen_name)}">@${esc(o.screen_name)}</a> asked to add you as an affiliate: their badge would show next to your name.${mine && mine.screen_name !== o.screen_name ? ` You'd leave @${esc(mine.screen_name)}.` : ""}</span>
<span class="row">${form("accept", { org: o.id }, "Accept", "")}${form("decline", { org: o.id }, "Decline")}</span></div>`,
			)
			.join("")}`;

	if (mine && !org)
		body += `<p>You are an affiliate of <a href="/${esc(mine.screen_name)}">@${esc(mine.screen_name)}</a>.</p>${form("leave", {}, "Leave the organisation", "danger")}`;

	if (org) {
		const people = await sql`select u.id::text, u.screen_name, u.name, a.manager from affiliations a join users u on u.id = a.user_id
			where a.org_id = ${org.id}::bigint order by a.manager desc, a.created_at`;
		const pending = await sql`select u.id::text, u.screen_name, u.name from affiliation_requests r join users u on u.id = r.user_id
			where r.org_id = ${org.id}::bigint order by r.created_at`;
		body += `<p>${org.self ? "You" : `As a manager of <a href="/${esc(org.screen_name)}">@${esc(org.screen_name)}</a>, you`} can add people to the organisation; they accept first. ${org.self ? "Managers can do the same." : ""}</p>
<form method="post" class="row"><input type="hidden" name="do" value="add"><input name="handle" placeholder="@handle" required><button>Ask to add</button></form>
<h2>Affiliates</h2>${
			people.length
				? people
						.map(
							(p: any) => `<div class="person"><span><b>${esc(p.name)}</b> <a href="/${esc(p.screen_name)}">@${esc(p.screen_name)}</a>${p.manager ? ' <span class="dim">· manager</span>' : ""}</span>
<span class="row">${org.self ? form("manager", { user: p.id, on: p.manager ? "" : "1" }, p.manager ? "Not a manager" : "Make manager") : ""}${p.id !== viewer.id ? form("remove", { user: p.id }, "Remove", "danger") : ""}</span></div>`,
						)
						.join("")
				: '<p class="dim">No affiliates yet.</p>'
		}${
			pending.length
				? `<h2>Waiting to accept</h2>${pending
						.map((p: any) => `<div class="person"><span><b>${esc(p.name)}</b> <a href="/${esc(p.screen_name)}">@${esc(p.screen_name)}</a></span>${form("cancel", { user: p.id }, "Withdraw")}</div>`)
						.join("")}`
				: ""
		}`;
	}

	if (!org && !mine && !asked.length) body += '<p class="dim">This page is for organisations (accounts with the gold badge) and the people they add.</p>';
	return page(body);
}

const isId = (v: string) => /^\d{1,19}$/.test(v);

export async function orgRoute(req: Request, viewer: Viewer): Promise<Response> {
	if (req.method !== "POST") return view(viewer);
	const f = await req.formData().catch(() => undefined);
	const field = (k: string) => String(f?.get(k) ?? "").trim();
	const action = field("do");

	if (action === "accept" || action === "decline") {
		const orgId = field("org");
		if (!isId(orgId)) return view(viewer, "No such request.");
		const [r] = await sql`delete from affiliation_requests r using users o
			where r.org_id = ${orgId}::bigint and r.user_id = ${viewer.id}::bigint and o.id = r.org_id and o.verified_type = 'business' returning o.screen_name`;
		if (!r) return view(viewer, "That request is gone.");
		if (action === "decline") return view(viewer, "", `You declined @${r.screen_name}.`);
		// one organisation per person; accepting moves them
		await sql`insert into affiliations (org_id, user_id) values (${orgId}::bigint, ${viewer.id}::bigint)
			on conflict (user_id) do update set org_id = excluded.org_id, manager = false, created_at = now()`;
		return view(viewer, "", `You are now an affiliate of @${r.screen_name}.`);
	}
	if (action === "leave") {
		await sql`delete from affiliations where user_id = ${viewer.id}::bigint`;
		return view(viewer, "", "You left the organisation.");
	}

	const org = await managedOrg(viewer);
	if (!org) return view(viewer, "Only an organisation and its managers can do that.");
	const userId = field("user");
	if (action === "add") {
		const handle = field("handle").replace(/^@/, "");
		const [u] = await sql`select id::text, screen_name, verified_type, status from users where lower(screen_name) = lower(${handle})`;
		if (!u || u.status === "suspended") return view(viewer, "No account with that handle.");
		if (u.id === org.id) return view(viewer, "An organisation can't be its own affiliate.");
		if (u.verified_type === "business") return view(viewer, "Organisations can't be affiliates.");
		if ((await sql`select 1 from affiliations where org_id = ${org.id}::bigint and user_id = ${u.id}::bigint`).length) return view(viewer, `@${u.screen_name} is already an affiliate.`);
		// a block either way keeps the request from reaching them
		if ((await sql`select 1 from blocks where (blocker_id = ${u.id}::bigint and blocked_id in (${org.id}::bigint, ${viewer.id}::bigint)) or (blocked_id = ${u.id}::bigint and blocker_id in (${org.id}::bigint, ${viewer.id}::bigint))`).length)
			return view(viewer, `You can't add @${u.screen_name}.`);
		await sql`insert into affiliation_requests (org_id, user_id, requested_by) values (${org.id}::bigint, ${u.id}::bigint, ${viewer.id}::bigint) on conflict do nothing`;
		return view(viewer, "", `Asked @${u.screen_name}. They become an affiliate when they accept.`);
	}
	if (!isId(userId)) return view(viewer, "Choose an account.");
	if (action === "cancel") {
		await sql`delete from affiliation_requests where org_id = ${org.id}::bigint and user_id = ${userId}::bigint`;
		return view(viewer, "", "Request withdrawn.");
	}
	if (action === "remove") {
		if (userId === viewer.id) return view(viewer, "Leave from your own page instead.");
		// managers can't remove the people who can remove them; the organisation can
		const [target] = await sql`select manager from affiliations where org_id = ${org.id}::bigint and user_id = ${userId}::bigint`;
		if (!target) return view(viewer, "Not an affiliate.");
		if (target.manager && !org.self) return view(viewer, "Only the organisation's own account removes a manager.");
		await sql`delete from affiliations where org_id = ${org.id}::bigint and user_id = ${userId}::bigint`;
		return view(viewer, "", "Removed.");
	}
	if (action === "manager") {
		if (!org.self) return view(viewer, "Only the organisation's own account chooses managers.");
		const rows = await sql`update affiliations set manager = ${field("on") === "1"} where org_id = ${org.id}::bigint and user_id = ${userId}::bigint returning user_id`;
		return rows.length ? view(viewer, "", field("on") === "1" ? "They can now manage affiliates." : "They no longer manage affiliates.") : view(viewer, "Not an affiliate.");
	}
	return view(viewer);
}
