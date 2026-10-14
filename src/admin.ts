// The admin panel's API: POST /admin/api/<action> with a JSON body, from a
// signed-in staff account, with the csrf header like every other write.
//
// Roles: support reads everything and can reset passwords and sign people
// out; moderators also change an account's standing and delete posts; admins
// do everything else (profiles, badges, roles, organisations, invites,
// instance settings). Every change is written to the audit log.

import type { Viewer } from "./auth";
import { sql } from "./db";
import { isFlag } from "./flags";
import { isId, newId } from "./ids";
import { createInvite } from "./invites";
import { type SignupMode, allSettings, setSetting } from "./settings";

type Role = "admin" | "moderator" | "support";
const RANK: Record<Role, number> = { support: 1, moderator: 2, admin: 3 };

class AdminError extends Error {
	constructor(
		message: string,
		public status = 400,
	) {
		super(message);
	}
}

type Body = Record<string, any>;
type Action = { role: Role; run: (actor: Viewer, b: Body) => Promise<unknown> };

async function audit(actor: Viewer, action: string, target: string | null, detail: unknown = null) {
	await sql`insert into audit_log (id, actor_id, action, target, detail)
		values (${newId()}::bigint, ${actor.id}::bigint, ${action}, ${target}, ${detail === null ? null : JSON.stringify(detail)}::text::jsonb)`;
}

const idOf = (v: unknown, what = "id") => {
	if (typeof v === "number") v = String(v);
	if (!isId(v)) throw new AdminError(`Missing or bad ${what}.`);
	return v as string;
};

async function userRow(id: string) {
	const [u] = await sql`select id, screen_name, role, status from users where id = ${id}::bigint`;
	if (!u) throw new AdminError("No such account.", 404);
	return u;
}

// nobody acts on an account ranked at or above their own, except on themselves
async function guard(actor: Viewer, targetId: string) {
	const u = await userRow(targetId);
	if (targetId !== actor.id && u.role && RANK[u.role as Role] >= RANK[actor.role as Role])
		throw new AdminError("That account is staff at your level or above.", 403);
	return u;
}

const randomPassword = () => {
	const alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
	return [...crypto.getRandomValues(new Uint8Array(14))].map((b) => alphabet[b % alphabet.length]).join("");
};

const like = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

const userListCols = sql`u.id::text as id, u.screen_name, u.name, u.avatar_url, u.verified_type, u.flag, u.status, u.role,
	u.created_at, u.last_seen_at, u.invite_code,
	(select count(*)::int from posts p where p.user_id = u.id) as posts,
	(select count(*)::int from follows f where f.followee_id = u.id) as followers,
	(select o.screen_name from affiliations af join users o on o.id = af.org_id where af.user_id = u.id) as org,
	(select count(*)::int from affiliations af where af.org_id = u.id) as affiliates`;

const ACTIONS: Record<string, Action> = {
	me: { role: "support", run: async (a) => ({ id: a.id, screen_name: a.screen_name, role: a.role }) },

	stats: {
		role: "support",
		run: async () => {
			const [s] = await sql`select
				(select count(*)::int from users) as users,
				(select count(*)::int from users where status <> 'active') as sanctioned,
				(select count(*)::int from users where last_seen_at > now() - interval '7 days') as active_week,
				(select count(*)::int from posts) as posts,
				(select count(*)::int from posts where created_at > now() - interval '1 day') as posts_today,
				(select count(*)::int from likes) as likes,
				(select count(*)::int from media) as media,
				(select coalesce(sum(size), 0)::bigint::text from media) as media_bytes,
				(select count(*)::int from media where state = 'processing') as videos_processing,
				(select count(*)::int from invites where not revoked and uses < max_uses and (expires_at is null or expires_at > now())) as open_invites`;
			const days = await sql`select to_char(d, 'YYYY-MM-DD') as day,
				(select count(*)::int from posts p where p.created_at >= d and p.created_at < d + interval '1 day') as posts,
				(select count(*)::int from users u where u.created_at >= d and u.created_at < d + interval '1 day') as signups
				from generate_series(date_trunc('day', now()) - interval '13 days', date_trunc('day', now()), interval '1 day') d order by d`;
			return { ...s, days };
		},
	},

	users: {
		role: "support",
		run: async (_a, b) => {
			const q = String(b.q ?? "").trim().replace(/^@/, "");
			const status = ["active", "restricted", "limited", "suspended"].includes(b.status) ? b.status : null;
			const staff = !!b.staff;
			const rows = await sql`select ${userListCols} from users u
				where (${q} = '' or u.screen_name ilike ${like(q)} or u.name ilike ${like(q)})
					and (${status}::text is null or u.status = ${status})
					and (not ${staff} or u.role is not null)
				order by u.created_at desc limit 50 offset ${Number(b.offset) || 0}`;
			return { users: rows };
		},
	},

	user: {
		role: "support",
		run: async (_a, b) => {
			const id = idOf(b.id);
			const [u] = await sql`select ${userListCols}, u.bio, u.location, u.website,
				(select count(*)::int from sessions s where s.user_id = u.id) as sessions,
				(select c.screen_name from invites i join users c on c.id = i.created_by where i.code = u.invite_code) as invited_by
				from users u where u.id = ${id}::bigint`;
			if (!u) throw new AdminError("No such account.", 404);
			const invited = await sql`select u.id::text as id, u.screen_name from users u join invites i on i.code = u.invite_code
				where i.created_by = ${id}::bigint order by u.created_at`;
			const log = await sql`select l.action, l.detail, l.created_at, a.screen_name as actor from audit_log l
				left join users a on a.id = l.actor_id where l.target = ${id} order by l.id desc limit 50`;
			return { user: u, invited, log };
		},
	},

	updateUser: {
		role: "admin",
		run: async (a, b) => {
			const id = idOf(b.id);
			await guard(a, id);
			const limits: Record<string, [string, number]> = { name: ["name", 50], screen_name: ["screen_name", 15], bio: ["bio", 160], location: ["location", 30], website: ["website", 100] };
			const changes: Record<string, string> = {};
			for (const [field, [column, max]] of Object.entries(limits)) {
				if (typeof b[field] !== "string") continue;
				const value = b[field].trim();
				if ([...value].length > max) throw new AdminError(`${field} is at most ${max} characters.`);
				if (field === "screen_name" && !/^[A-Za-z0-9_]{1,15}$/.test(value)) throw new AdminError("Handles are letters, digits and underscores.");
				if (field === "name" && !value) throw new AdminError("Name can't be blank.");
				if (field === "website" && value && !/^https?:\/\/\S+$/.test(value)) throw new AdminError("Website must be an http or https address.");
				changes[column] = value;
			}
			if (!Object.keys(changes).length) return {};
			if (changes.screen_name) {
				const [taken] = await sql`select 1 from users where lower(screen_name) = lower(${changes.screen_name}) and id <> ${id}::bigint`;
				if (taken) throw new AdminError("That handle is taken.");
			}
			await sql`update users set ${sql(changes)} where id = ${id}::bigint`;
			await audit(a, "edit_profile", id, changes);
			return {};
		},
	},

	setBadge: {
		role: "admin",
		run: async (a, b) => {
			const id = idOf(b.id);
			const badge = b.badge || null;
			if (badge !== null && !["blue", "business", "government"].includes(badge)) throw new AdminError("Unknown badge.");
			await guard(a, id);
			// an account stops being an organisation when it loses the gold badge
			if (badge !== "business") await sql`delete from affiliations where org_id = ${id}::bigint`;
			await sql`update users set verified_type = ${badge} where id = ${id}::bigint`;
			await audit(a, "set_badge", id, { badge });
			return {};
		},
	},

	setFlag: {
		role: "admin",
		run: async (a, b) => {
			const id = idOf(b.id);
			const flag = b.flag || null;
			if (flag !== null && !isFlag(flag)) throw new AdminError("Unknown flag.");
			await guard(a, id);
			await sql`update users set flag = ${flag} where id = ${id}::bigint`;
			await audit(a, "set_flag", id, { flag });
			return {};
		},
	},

	setStatus: {
		role: "moderator",
		run: async (a, b) => {
			const id = idOf(b.id);
			const status = b.status;
			if (!["active", "restricted", "limited", "suspended"].includes(status)) throw new AdminError("Unknown standing.");
			if (id === a.id) throw new AdminError("You can't change your own standing.");
			await guard(a, id);
			await sql`update users set status = ${status} where id = ${id}::bigint`;
			if (status === "suspended") await sql`delete from sessions where user_id = ${id}::bigint`;
			await audit(a, "set_status", id, { status, reason: String(b.reason ?? "").slice(0, 500) || undefined });
			return {};
		},
	},

	setRole: {
		role: "admin",
		run: async (a, b) => {
			const id = idOf(b.id);
			const role = b.role || null;
			if (role !== null && !(role in RANK)) throw new AdminError("Unknown role.");
			if (id === a.id && role !== "admin") {
				const [{ n }] = await sql`select count(*)::int as n from users where role = 'admin'`;
				if (n <= 1) throw new AdminError("You are the last admin.");
			}
			await userRow(id);
			await sql`update users set role = ${role} where id = ${id}::bigint`;
			await audit(a, "set_role", id, { role });
			return {};
		},
	},

	resetPassword: {
		role: "support",
		run: async (a, b) => {
			const id = idOf(b.id);
			await guard(a, id);
			const password = randomPassword();
			await sql`update users set password_hash = ${await Bun.password.hash(password)} where id = ${id}::bigint`;
			await sql`delete from sessions where user_id = ${id}::bigint`;
			await audit(a, "reset_password", id);
			return { password };
		},
	},

	signOut: {
		role: "support",
		run: async (a, b) => {
			const id = idOf(b.id);
			await guard(a, id);
			const rows = await sql`delete from sessions where user_id = ${id}::bigint returning token`;
			await audit(a, "sign_out", id, { sessions: rows.length });
			return { sessions: rows.length };
		},
	},

	deleteUser: {
		role: "admin",
		run: async (a, b) => {
			const id = idOf(b.id);
			if (id === a.id) throw new AdminError("You can't delete your own account here.");
			const u = await guard(a, id);
			if (String(b.confirm ?? "").toLowerCase() !== u.screen_name.toLowerCase()) throw new AdminError("Type the handle to confirm.");
			await sql`delete from users where id = ${id}::bigint`;
			await audit(a, "delete_account", id, { screen_name: u.screen_name });
			return {};
		},
	},

	orgs: {
		role: "support",
		run: async () => ({
			orgs: await sql`select ${userListCols} from users u where u.verified_type = 'business' order by u.name`,
		}),
	},

	createOrg: {
		role: "admin",
		run: async (a, b) => {
			const screenName = String(b.screen_name ?? "").trim().replace(/^@/, "");
			const name = String(b.name ?? "").trim() || screenName;
			if (!/^[A-Za-z0-9_]{4,15}$/.test(screenName)) throw new AdminError("Handles are 4 to 15 letters, digits or underscores.");
			const [taken] = await sql`select 1 from users where lower(screen_name) = lower(${screenName})`;
			if (taken) throw new AdminError("That handle is taken.");
			const password = randomPassword();
			const id = newId();
			await sql`insert into users (id, screen_name, name, password_hash, verified_type)
				values (${id}::bigint, ${screenName}, ${name}, ${await Bun.password.hash(password)}, 'business')`;
			await audit(a, "create_org", id, { screen_name: screenName });
			return { id, password };
		},
	},

	affiliates: {
		role: "support",
		run: async (_a, b) => ({
			affiliates: await sql`select ${userListCols} from affiliations af join users u on u.id = af.user_id
				where af.org_id = ${idOf(b.orgId, "organisation")}::bigint order by af.created_at desc`,
		}),
	},

	addAffiliate: {
		role: "admin",
		run: async (a, b) => {
			const orgId = idOf(b.orgId, "organisation");
			const [org] = await sql`select verified_type from users where id = ${orgId}::bigint`;
			if (org?.verified_type !== "business") throw new AdminError("Only accounts with the gold badge are organisations.");
			const [u] = await sql`select id::text as id from users where lower(screen_name) = lower(${String(b.screen_name ?? "").replace(/^@/, "")})`;
			if (!u) throw new AdminError("No account with that handle.");
			if (u.id === orgId) throw new AdminError("An organisation can't be its own affiliate.");
			// one organisation per person; adding moves them
			await sql`insert into affiliations (org_id, user_id) values (${orgId}::bigint, ${u.id}::bigint)
				on conflict (user_id) do update set org_id = excluded.org_id, created_at = now()`;
			await audit(a, "add_affiliate", u.id, { org: orgId });
			return {};
		},
	},

	removeAffiliate: {
		role: "admin",
		run: async (a, b) => {
			const orgId = idOf(b.orgId, "organisation");
			const userId = idOf(b.userId, "account");
			await sql`delete from affiliations where org_id = ${orgId}::bigint and user_id = ${userId}::bigint`;
			await audit(a, "remove_affiliate", userId, { org: orgId });
			return {};
		},
	},

	posts: {
		role: "support",
		run: async (_a, b) => {
			const q = String(b.q ?? "").trim();
			const author = String(b.author ?? "").trim().replace(/^@/, "");
			const rows = await sql`select p.id::text as id, p.text, p.created_at, p.reply_to_id::text as reply_to_id, u.screen_name, u.name,
				(select count(*)::int from likes l where l.post_id = p.id) as likes,
				(select count(*)::int from media m where m.post_id = p.id) as media
				from posts p join users u on u.id = p.user_id
				where (${q} = '' or p.text ilike ${like(q)}) and (${author} = '' or lower(u.screen_name) = lower(${author}))
				order by p.id desc limit 50 offset ${Number(b.offset) || 0}`;
			return { posts: rows };
		},
	},

	deletePost: {
		role: "moderator",
		run: async (a, b) => {
			const id = idOf(b.id, "post");
			const [p] = await sql`select p.text, p.user_id::text as user_id from posts p where p.id = ${id}::bigint`;
			if (!p) throw new AdminError("No such post.", 404);
			await guard(a, p.user_id);
			await sql`delete from posts where id = ${id}::bigint`;
			await audit(a, "delete_post", p.user_id, { post: id, text: p.text.slice(0, 280) });
			return {};
		},
	},

	invites: {
		role: "support",
		run: async () => ({
			invites: await sql`select i.code, i.max_uses, i.uses, i.expires_at, i.revoked, i.created_at,
				c.screen_name as created_by, o.screen_name as org,
				(select coalesce(json_agg(u.screen_name order by u.created_at), '[]') from users u where u.invite_code = i.code) as used_by
				from invites i left join users c on c.id = i.created_by left join users o on o.id = i.org_id
				order by i.created_at desc limit 200`,
		}),
	},

	createInvite: {
		role: "admin",
		run: async (a, b) => {
			const count = Math.min(Math.max(Number(b.count) || 1, 1), 50);
			const maxUses = Math.min(Math.max(Number(b.uses) || 1, 1), 10000);
			const days = Number(b.days) || 0;
			const orgId = b.orgId ? idOf(b.orgId, "organisation") : undefined;
			const codes: string[] = [];
			for (let i = 0; i < count; i++)
				codes.push(await createInvite({ createdBy: a.id, maxUses, expiresAt: days > 0 ? new Date(Date.now() + days * 86400e3) : undefined, orgId }));
			await audit(a, "create_invites", null, { count, maxUses, days: days || undefined, org: orgId });
			return { codes };
		},
	},

	revokeInvite: {
		role: "admin",
		run: async (a, b) => {
			const code = String(b.code ?? "");
			await sql`update invites set revoked = true where code = ${code}`;
			await audit(a, "revoke_invite", null, { code });
			return {};
		},
	},

	settings: { role: "support", run: async () => ({ settings: await allSettings() }) },

	setSignupMode: {
		role: "admin",
		run: async (a, b) => {
			const mode = b.mode as SignupMode;
			if (!["invite", "open", "closed"].includes(mode)) throw new AdminError("Unknown sign-up mode.");
			await setSetting("signup_mode", mode);
			await audit(a, "set_signup_mode", null, { mode });
			return {};
		},
	},

	audit: {
		role: "support",
		run: async (_a, b) => ({
			entries: await sql`select l.id::text as id, l.action, l.target, l.detail, l.created_at, a.screen_name as actor,
				t.screen_name as target_name
				from audit_log l left join users a on a.id = l.actor_id
				left join users t on l.target ~ '^[0-9]+$' and t.id = l.target::bigint
				order by l.id desc limit 100 offset ${Number(b.offset) || 0}`,
		}),
	},
};

export async function adminApi(req: Request, action: string, viewer: Viewer | undefined): Promise<Response> {
	const fail = (message: string, status: number) => Response.json({ error: message }, { status });
	if (!viewer?.role) return fail("Staff only.", 403);
	if (req.method !== "POST") return fail("Use POST.", 405);
	if (req.headers.get("x-csrf-token") !== viewer.csrf) return fail("Missing csrf token.", 403);
	const a = ACTIONS[action];
	if (!a) return fail("Unknown action.", 404);
	if (RANK[viewer.role as Role] < RANK[a.role]) return fail(`Needs the ${a.role} role.`, 403);
	const body = await req.json().catch(() => ({}));
	try {
		return Response.json((await a.run(viewer, body ?? {})) ?? {});
	} catch (e) {
		if (e instanceof AdminError) return fail(e.message, e.status);
		throw e;
	}
}
