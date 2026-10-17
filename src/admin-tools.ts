// The admin panel's moderation and instance tools: custom badges, private staff
// notes, messages and strikes, appeals, temporary sanctions, sessions, post
// and article visibility, media, instance controls and server health.
// Registered into admin.ts's actions; the same role rules apply.

import { existsSync, realpathSync, unlinkSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { type Action, AdminError, audit, guard, idOf } from "./admin";
import { loadBuild } from "./build";
import { sql } from "./db";
import { newId } from "./ids";
import { MEDIA_DIR, sniffImage } from "./media";
import { setSetting, settings } from "./settings";

const STANDINGS = ["active", "restricted", "limited", "suspended"];

function textOf(value: unknown, max = 2000) {
	const text = typeof value === "string" ? value.trim() : "";
	if (!text || [...text].length > max) throw new AdminError(`Enter 1–${max} characters.`);
	return text;
}

// one entry per line, trimmed and lower-cased, without repeats
function lines(value: unknown, what: string, tags = false) {
	if (!Array.isArray(value) || value.length > 500 || value.some((x) => typeof x !== "string" || x.length > 80)) throw new AdminError(`Invalid ${what} list.`);
	const out = [...new Set((value as string[]).map((x) => x.trim().toLowerCase()).filter(Boolean))];
	if (tags && out.some((x) => !/^#?[\p{L}\p{N}_]+$/u.test(x))) throw new AdminError("Trends must be hashtag names.");
	return tags ? out.map((x) => x.replace(/^#/, "")) : out;
}

async function badgeExists(id: string | null) {
	if (id && !(await sql`select 1 from custom_badges where id = ${id}::bigint`).length) throw new AdminError("No such badge.");
}

export const toolActions: Record<string, Action> = {
	// custom badges: an image shown in the badge slot after a name
	badges: { role: "support", run: async () => ({ badges: await sql`select id::text, name, mime, created_at,
		(select count(*)::int from users u where u.org_badge_id = b.id or exists (select 1 from user_badges ub where ub.user_id = u.id and ub.badge_id = b.id)) as users
		from custom_badges b order by name` }) },
	createBadge: {
		role: "admin",
		run: async (a, b) => {
			const name = textOf(b.name, 60);
			const encoded = typeof b.image === "string" ? b.image : "";
			if (!encoded || encoded.length > 350_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new AdminError("Upload an image up to 256 KB.");
			const image = Buffer.from(encoded, "base64");
			const info = sniffImage(image);
			if (image.length > 256 * 1024 || !info || !["image/png", "image/jpeg", "image/webp"].includes(info.mime) || info.width > 1024 || info.height > 1024)
				throw new AdminError("Use a PNG, JPEG or WebP up to 1024×1024 and 256 KB.");
			const id = newId();
			await sql`insert into custom_badges (id, name, image, mime) values (${id}::bigint, ${name}, ${image}, ${info.mime})`;
			await audit(a, "create_badge", id, { name });
			return { id };
		},
	},
	deleteBadge: {
		role: "admin",
		run: async (a, b) => {
			const id = idOf(b.id);
			await sql`delete from custom_badges where id = ${id}::bigint`;
			await audit(a, "delete_badge", id);
			return {};
		},
	},
	// an account's custom badges, in the order they show
	setBadges: {
		role: "admin",
		run: async (a, b) => {
			const id = idOf(b.id);
			await guard(a, id);
			if (!Array.isArray(b.badgeIds) || b.badgeIds.length > 10) throw new AdminError("Choose up to 10 badges.");
			const badges = [...new Set(b.badgeIds.map((x: unknown) => idOf(x, "badge")))] as string[];
			for (const badge of badges) await badgeExists(badge);
			await sql.begin(async (tx) => {
				await tx`delete from user_badges where user_id = ${id}::bigint`;
				for (const [position, badge] of badges.entries())
					await tx`insert into user_badges (user_id, badge_id, position) values (${id}::bigint, ${badge}::bigint, ${position})`;
			});
			await audit(a, "set_badges", id, { badges });
			return {};
		},
	},
	// an organisation's badge for its affiliates, instead of its profile picture
	setOrgBadge: {
		role: "admin",
		run: async (a, b) => {
			const id = idOf(b.id);
			await guard(a, id);
			const badge = b.badgeId ? idOf(b.badgeId) : null;
			await badgeExists(badge);
			const rows = await sql`update users set org_badge_id = ${badge}::bigint where id = ${id}::bigint and verified_type = 'business' returning id`;
			if (!rows.length) throw new AdminError("Only organisations have an organisation badge.");
			await audit(a, "org_badge", id, { badge });
			return {};
		},
	},

	// notes about an account that only staff see
	staffNotes: { role: "support", run: async (_a, b) => ({ notes: await sql`select n.id::text, n.body, n.created_at, u.screen_name as actor
		from staff_notes n left join users u on u.id = n.actor_id where n.user_id = ${idOf(b.id)}::bigint order by n.id desc limit 100` }) },
	addStaffNote: {
		role: "support",
		run: async (a, b) => {
			const id = idOf(b.id);
			await guard(a, id);
			await sql`insert into staff_notes (id, user_id, actor_id, body) values (${newId()}::bigint, ${id}::bigint, ${a.id}::bigint, ${textOf(b.body)})`;
			await audit(a, "add_staff_note", id);
			return {};
		},
	},

	// messages, warnings and strikes: the account sees them in its notifications
	staffMessages: { role: "support", run: async (_a, b) => ({ messages: await sql`select m.id::text, m.kind, m.body, m.created_at, m.read_at, m.revoked_at, u.screen_name as actor
		from staff_messages m left join users u on u.id = m.actor_id where m.user_id = ${idOf(b.id)}::bigint order by m.id desc limit 100` }) },
	sendStaffMessage: {
		role: "moderator",
		run: async (a, b) => {
			const id = idOf(b.id);
			await guard(a, id);
			const kind = b.kind ?? "message";
			if (!["message", "warning", "strike"].includes(kind)) throw new AdminError("Unknown message type.");
			const message = newId();
			await sql`insert into staff_messages (id, user_id, actor_id, kind, body) values (${message}::bigint, ${id}::bigint, ${a.id}::bigint, ${kind}, ${textOf(b.body)})`;
			await audit(a, "send_staff_message", id, { kind, message });
			return { id: message };
		},
	},
	revokeStrike: {
		role: "moderator",
		run: async (a, b) => {
			const id = idOf(b.id);
			const [m] = await sql`select user_id::text from staff_messages where id = ${id}::bigint and kind = 'strike'`;
			if (!m) throw new AdminError("No such strike.");
			await guard(a, m.user_id);
			await sql`update staff_messages set revoked_at = now() where id = ${id}::bigint`;
			await audit(a, "revoke_strike", m.user_id, { message: id });
			return {};
		},
	},

	appeals: {
		role: "moderator",
		run: async (_a, b) => ({ appeals: await sql`select ap.id::text, ap.user_id::text, u.screen_name, u.name, u.avatar_url, u.status as user_status, ap.body, ap.status, ap.created_at, ap.staff_reply, ap.resolved_at,
			m.kind as message_kind, m.body as message_body, r.screen_name as reviewer
			from moderation_appeals ap join users u on u.id = ap.user_id left join staff_messages m on m.id = ap.message_id left join users r on r.id = ap.reviewer_id
			where ${b.status === "closed" ? sql`ap.status <> 'open'` : sql`ap.status = 'open'`} order by ap.id desc limit 100` }),
	},
	resolveAppeal: {
		role: "moderator",
		run: async (a, b) => {
			const id = idOf(b.id);
			const [ap] = await sql`select user_id::text from moderation_appeals where id = ${id}::bigint and status = 'open'`;
			if (!ap) throw new AdminError("No such open appeal.", 404);
			await guard(a, ap.user_id);
			if (!["accepted", "rejected"].includes(b.status)) throw new AdminError("Choose an outcome.");
			await sql`update moderation_appeals set status = ${b.status}, staff_reply = ${textOf(b.reply)}, reviewer_id = ${a.id}::bigint, resolved_at = now() where id = ${id}::bigint`;
			await audit(a, "resolve_appeal", ap.user_id, { appeal: id, status: b.status });
			return {};
		},
	},

	// a standing that goes back to the previous one after some hours
	setTemporaryStatus: {
		role: "moderator",
		run: async (a, b) => {
			const id = idOf(b.id);
			if (id === a.id) throw new AdminError("You can't change your own standing.");
			const user = await guard(a, id);
			if (!["restricted", "limited", "suspended"].includes(b.status)) throw new AdminError("Choose a sanction.");
			const hours = Number(b.hours);
			if (!Number.isFinite(hours) || hours < 1 || hours > 8760) throw new AdminError("Choose 1–8760 hours.");
			await sql`update users set status_restore = coalesce(status_restore, status), status = ${b.status}, status_until = now() + ${hours} * interval '1 hour' where id = ${id}::bigint`;
			if (b.status === "suspended") await sql`delete from sessions where user_id = ${id}::bigint`;
			await audit(a, "temporary_status", id, { status: b.status, hours, previous: user.status, reason: String(b.reason ?? "").slice(0, 500) || undefined });
			return {};
		},
	},
	bulkStatus: {
		role: "moderator",
		run: async (a, b) => {
			if (!Array.isArray(b.ids) || !b.ids.length || b.ids.length > 50 || !STANDINGS.includes(b.status)) throw new AdminError("Choose up to 50 accounts and a standing.");
			const ids = [...new Set(b.ids.map((x: unknown) => idOf(x)))] as string[];
			for (const id of ids) {
				if (id === a.id) throw new AdminError("You can't change your own standing.");
				await guard(a, id);
			}
			await sql.begin(async (tx) => {
				await tx`update users set status = ${b.status}, status_until = null, status_restore = null where id = any(${tx.array(ids, "INT8")})`;
				if (b.status === "suspended") await tx`delete from sessions where user_id = any(${tx.array(ids, "INT8")})`;
			});
			await audit(a, "bulk_status", null, { ids, status: b.status });
			return { count: ids.length };
		},
	},

	// earlier handles, newest first; old links to them stop working once changed
	handleHistory: {
		role: "support",
		run: async (a, b) => {
			const id = idOf(b.id);
			await guard(a, id);
			return { changes: await sql`select old_name, new_name, changed_at from username_changes where user_id = ${id}::bigint order by changed_at desc limit 50` };
		},
	},
	// signed-in browsers; the token itself never leaves the server
	userSessions: {
		role: "support",
		run: async (a, b) => {
			const id = idOf(b.id);
			await guard(a, id);
			return { sessions: await sql`select id::text, created_at, last_seen_at, user_agent, ip, token = ${a.token} as current from sessions where user_id = ${id}::bigint order by last_seen_at desc` };
		},
	},
	revokeSession: {
		role: "support",
		run: async (a, b) => {
			if (typeof b.sessionId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(b.sessionId)) throw new AdminError("Invalid session id.");
			const [s] = await sql`select user_id::text from sessions where id = ${b.sessionId}::uuid`;
			if (!s) throw new AdminError("No such session.", 404);
			await guard(a, s.user_id);
			await sql`delete from sessions where id = ${b.sessionId}::uuid`;
			await audit(a, "revoke_session", s.user_id, { session: b.sessionId });
			return {};
		},
	},

	// hidden: only staff see it; sensitive: media behind X's content warning
	setPostVisibility: {
		role: "moderator",
		run: async (a, b) => {
			const id = idOf(b.id);
			const [p] = await sql`select user_id::text from posts where id = ${id}::bigint`;
			if (!p) throw new AdminError("No such post.", 404);
			await guard(a, p.user_id);
			if (typeof b.hidden !== "boolean" || typeof b.sensitive !== "boolean") throw new AdminError("Provide visibility and sensitivity settings.");
			await sql`update posts set hidden = ${b.hidden}, sensitive = ${b.sensitive} where id = ${id}::bigint`;
			await audit(a, "set_post_visibility", p.user_id, { post: id, hidden: b.hidden, sensitive: b.sensitive });
			return {};
		},
	},
	articles: { role: "support", run: async () => ({ articles: await sql`select a.id::text, a.user_id::text, u.screen_name, a.title, a.state, a.hidden, a.modified_at,
		(select p.id::text from posts p where p.article_id = a.id order by p.id desc limit 1) as post_id
		from articles a join users u on u.id = a.user_id order by a.id desc limit 100` }) },
	setArticleVisibility: {
		role: "moderator",
		run: async (a, b) => {
			const id = idOf(b.id);
			const [article] = await sql`select user_id::text from articles where id = ${id}::bigint`;
			if (!article) throw new AdminError("No such article.", 404);
			await guard(a, article.user_id);
			if (typeof b.hidden !== "boolean") throw new AdminError("Choose visibility.");
			await sql.begin(async (tx) => {
				await tx`update articles set hidden = ${b.hidden} where id = ${id}::bigint`;
				await tx`update posts set hidden = ${b.hidden} where article_id = ${id}::bigint`;
			});
			await audit(a, "article_visibility", article.user_id, { article: id, hidden: b.hidden });
			return {};
		},
	},

	media: {
		role: "support",
		run: async (_a, b) => ({ media: await sql`select m.id::text, m.user_id::text, u.screen_name, m.kind, m.mime, m.size, m.state, m.created_at, m.post_id::text
			from media m join users u on u.id = m.user_id order by m.id desc limit 60 offset ${Math.max(0, Number(b.offset) || 0)}` }),
	},
	deleteMedia: {
		role: "moderator",
		run: async (a, b) => {
			const id = idOf(b.id);
			const [m] = await sql`select user_id::text, state from media where id = ${id}::bigint`;
			if (!m) throw new AdminError("No such media.", 404);
			await guard(a, m.user_id);
			if (m.state === "processing") throw new AdminError("Wait until processing finishes.");
			const root = realpathSync(resolve(MEDIA_DIR));
			for (const name of [id, `${id}.mp4`, `${id}.upload`, `poster/${id}.jpg`]) {
				const path = resolve(root, name);
				if (!existsSync(path)) continue;
				const parent = realpathSync(dirname(path));
				if (parent !== root && !parent.startsWith(root + sep)) throw new AdminError("Invalid media path.");
				unlinkSync(path);
			}
			await sql`delete from media where id = ${id}::bigint`;
			await sql`update users set avatar_url = null where avatar_url = ${`/media/${id}`}`;
			await sql`update users set banner_url = null where banner_url = ${`/media/banner/${id}`}`;
			await audit(a, "delete_media", m.user_id, { media: id });
			return {};
		},
	},

	// maintenance mode, blocked phrases, trend controls and the pinned post
	operations: { role: "support", run: async () => ({ operations: settings().operations }) },
	saveOperations: {
		role: "admin",
		run: async (a, b) => {
			if (typeof b.maintenance !== "boolean" || typeof b.message !== "string" || b.message.length > 500) throw new AdminError("Invalid maintenance settings.");
			const pin = b.global_pin ? idOf(String(b.global_pin).trim(), "post id") : null;
			if (pin && !(await sql`select 1 from posts where id = ${pin}::bigint and not hidden`).length) throw new AdminError("Pin an existing visible post.");
			await setSetting("operations", {
				maintenance: b.maintenance,
				message: b.message.trim() || "The instance is undergoing maintenance.",
				blocked_phrases: lines(b.blocked_phrases, "phrase"),
				hidden_trends: lines(b.hidden_trends, "trend", true),
				promoted_trends: lines(b.promoted_trends, "trend", true),
				global_pin: pin,
			});
			await audit(a, "save_operations", null, { maintenance: b.maintenance, pin });
			return {};
		},
	},

	health: {
		role: "support",
		run: async () => {
			const started = performance.now();
			const [db] = await sql`select pg_database_size(current_database())::text as bytes`;
			return {
				runtime: Bun.version,
				uptime: Math.floor(process.uptime()),
				memory: process.memoryUsage().rss,
				database: { bytes: db.bytes, latency_ms: Math.round(performance.now() - started) },
				client_build: loadBuild()?.build.sha ?? null,
			};
		},
	},

	inviteTree: {
		role: "support",
		run: async () => ({
			tree: await sql`with recursive tree as (
				select u.id, u.screen_name, null::bigint as parent, 0 as depth, array[u.id] as path from users u
					where u.invite_code is null or not exists (select 1 from invites i where i.code = u.invite_code and i.created_by is not null)
				union all
				select u.id, u.screen_name, t.id, t.depth + 1, t.path || u.id from tree t
					join invites i on i.created_by = t.id join users u on u.invite_code = i.code
					where t.depth < 10 and not u.id = any(t.path)
			) select id::text, screen_name, parent::text, depth from tree order by path limit 1000`,
		}),
	},
};
