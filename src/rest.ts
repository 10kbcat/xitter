// The few REST endpoints the client still uses next to GraphQL.

import { type Viewer, clearedCookies, logout } from "./auth";
import { addKeyword, mutedKeywords, removeKeywords, setBlock, setMute, updateKeyword } from "./blocks";
import { sql } from "./db";
import { isId } from "./ids";
import { legacyUser } from "./model";
import { markSeen } from "./notifications";
import { settingsFor } from "./shell";
import { hashtagsLike, searchUsers } from "./search";
import { setFollow, userById, userByName, usersByIds } from "./users";

const profileError = (message: string) => Response.json({ errors: [{ code: 120, message }] }, { status: 403 });

async function form(req: Request): Promise<Record<string, string>> {
	const f = await req.formData().catch(() => undefined);
	const out: Record<string, string> = {};
	if (f) for (const [k, v] of f) if (typeof v === "string") out[k] = v;
	return out;
}

const changedUser = async (viewer: Viewer) => Response.json(legacyUser((await userById(viewer.id, viewer.id))!));

// account/update_profile, update_profile_image, update_profile_banner, remove_profile_banner
async function profileRoute(path: string, viewer: Viewer, req: Request): Promise<Response | undefined> {
	const m = /^\/1\.1\/account\/(update_profile|update_profile_image|update_profile_banner|remove_profile_banner)\.json$/.exec(path);
	if (!m || req.method !== "POST") return undefined;
	const f = await form(req);

	if (m[1] === "update_profile") {
		const limits: Record<string, [string, number]> = { name: ["name", 50], description: ["bio", 160], location: ["location", 30], url: ["website", 100] };
		for (const [field, [column, max]] of Object.entries(limits)) {
			if (!(field in f)) continue;
			const value = f[field].trim();
			if ([...value].length > max) return profileError(`${field} is limited to ${max} characters.`);
			if (field === "name" && !value) return profileError("Name can't be blank.");
			if (field === "url" && value && !/^https?:\/\/\S+$/.test(value)) return profileError("Website must be an http or https address.");
			await sql`update users set ${sql({ [column]: value })} where id = ${viewer.id}::bigint`;
		}
		return changedUser(viewer);
	}
	if (m[1] === "remove_profile_banner") {
		await sql`update users set banner_url = null where id = ${viewer.id}::bigint`;
		return changedUser(viewer);
	}
	// the image was uploaded first; only the viewer's own photo upload is accepted
	const mediaId = f.media_id;
	if (!isId(mediaId)) return profileError("Upload the image first and send its media_id.");
	const [media] = await sql`select id from media where id = ${mediaId}::bigint and user_id = ${viewer.id}::bigint`;
	if (!media) return profileError("Unknown upload.");
	if (m[1] === "update_profile_image") await sql`update users set avatar_url = ${`/media/${mediaId}`} where id = ${viewer.id}::bigint`;
	// the client appends a size like /1500x500 to banner addresses
	else await sql`update users set banner_url = ${`/media/banner/${mediaId}`} where id = ${viewer.id}::bigint`;
	return changedUser(viewer);
}

// analytics and ad reporting: accepted and dropped
const TELEMETRY = /\/flow\/|viewer_context|app_context|promoted_content|\/jot\/|csp_report|\/strato\/|\/p2$|update_subscriptions|client_event/;

const EMPTY_LIST = { users: [], next_cursor: 0, next_cursor_str: "0", previous_cursor: 0, previous_cursor_str: "0", total_count: 0 };

// `path` has no /i/api prefix
export async function restRoute(method: string, path: string, viewer: Viewer, req: Request): Promise<Response | undefined> {
	const profile = await profileRoute(path, viewer, req);
	if (profile) return profile;
	const friendship = /^\/1\.1\/friendships\/(create|destroy)\.json$/.exec(path);
	if (friendship && method === "POST") {
		const form = await req.formData().catch(() => undefined);
		const target = form?.get("user_id");
		if (!isId(target)) return Response.json({ errors: [{ code: 50, message: "User not found." }] }, { status: 404 });
		await setFollow(viewer.id, target, friendship[1] === "create");
		const user = await userById(viewer.id, target);
		if (!user) return Response.json({ errors: [{ code: 50, message: "User not found." }] }, { status: 404 });
		return Response.json(legacyUser(user));
	}
	const relation = /^\/1\.1\/(blocks|mutes\/users)\/(create|destroy)\.json$/.exec(path);
	if (relation && method === "POST") {
		const f = await form(req);
		const target = f.user_id ?? (f.screen_name ? (await userByName(viewer.id, f.screen_name))?.id : undefined);
		if (!isId(target) || target === viewer.id) return Response.json({ errors: [{ code: 50, message: "User not found." }] }, { status: 404 });
		const on = relation[2] === "create";
		if (relation[1] === "blocks") await setBlock(viewer.id, target, on);
		else await setMute(viewer.id, target, on);
		const user = await userById(viewer.id, target);
		if (!user) return Response.json({ errors: [{ code: 50, message: "User not found." }] }, { status: 404 });
		return Response.json(legacyUser(user));
	}
	const keywords = /^\/1\.1\/mutes\/keywords\/(list|create|update|destroy)\.json$/.exec(path);
	if (keywords) {
		const f = method === "POST" ? await form(req) : {};
		if (keywords[1] === "create") {
			const error = await addKeyword(viewer.id, f);
			if (error) return Response.json({ errors: [{ code: 214, message: error }] }, { status: 400 });
		} else if (keywords[1] === "update" && isId(f.id)) await updateKeyword(viewer.id, f.id, f);
		else if (keywords[1] === "destroy") await removeKeywords(viewer.id, (f.ids ?? "").split(",").filter(isId));
		return Response.json(await mutedKeywords(viewer.id));
	}
	// words the client warns about muting; there are none
	if (path === "/1.1/mutes/keywords/discouraged.json") return Response.json({ discouraged_keywords: [] });
	// notification filters (who may notify you); none are kept
	if (path === "/1.1/mutes/advanced_filters.json") return Response.json({});
	// the notifications page reports the newest entry it has shown
	if (/^\/2\/notifications\/\w+\/last_seen_cursor(\.json)?$/.test(path) && method === "POST") {
		const body = await req.text();
		let cursor: string | null = null;
		try {
			cursor = JSON.parse(body).cursor ?? null;
		} catch {
			cursor = new URLSearchParams(body).get("cursor");
		}
		await markSeen(viewer.id, cursor);
		return Response.json({ cursor });
	}
	// suggestions under the search box: accounts, and hashtags when one is being typed
	if (path === "/1.1/search/typeahead.json") {
		const q = (new URL(req.url).searchParams.get("q") ?? "").trim().slice(0, 100);
		const users = q && !q.startsWith("#") ? await usersByIds(viewer.id, await searchUsers(q, 8)) : new Map();
		const tags = q.startsWith("#") ? await hashtagsLike(q, 8) : [];
		return Response.json({
			num_results: users.size + tags.length,
			users: [...users.values()].map((u) => ({
				...legacyUser(u),
				ext_is_blue_verified: u.verified_type !== null,
				social_context: { following: u.stats?.followedByViewer ?? false, followed_by: u.stats?.followsViewer ?? false },
			})),
			topics: tags.map((topic) => ({ topic, rounded_score: 0, tokens: [{ token: topic }], inline: false, result_context: { display_string: "", types: [] } })),
			// the client maps over each of these lists, so none may be missing
			cashtags: [],
			events: [],
			lists: [],
			ordered_sections: [],
			oneclick: [],
			hashtags: [],
			completed_in: 0,
			query: q,
		});
	}
	if (path === "/1.1/account/settings.json") return Response.json(settingsFor(viewer) ?? {});
	if (path === "/1.1/account/logout.json" && method === "POST") {
		await logout(viewer.token);
		const headers = new Headers({ "content-type": "application/json" });
		for (const c of clearedCookies()) headers.append("set-cookie", c);
		return new Response(JSON.stringify({ status: "ok" }), { headers });
	}
	if (path === "/1.1/hashflags.json") return Response.json([]);
	if (path === "/fleets/v1/fleetline") return Response.json({ threads: [], hydrated_threads: [], refresh_delay_secs: 300 });
	if (path === "/fleets/v1/avatar_content") return Response.json({ users: {}, refresh_delay_secs: 0 });
	if (path === "/1.1/friends/following/list.json") return Response.json(EMPTY_LIST);
	if (path === "/1.1/live_pipeline/update_subscriptions") return Response.json({ subscriptions: { errors: [] } });
	if (path.endsWith("/p2"))
		return Response.json({ totalEvents: 0, eventsFailed: 0, shouldRetry: false, retryAfterMs: null, eventsFailedSequenceNumbers: null, message: null });
	if (TELEMETRY.test(path)) return Response.json({});
	return undefined;
}

// Server-sent events channel for live updates. Nothing is pushed yet; the
// stream only stays open so the client does not keep reconnecting.
export function livePipeline(): Response {
	let timer: Timer;
	const stream = new ReadableStream({
		start(controller) {
			controller.enqueue(":\n\n");
			timer = setInterval(() => controller.enqueue(":\n\n"), 25_000);
		},
		cancel() {
			clearInterval(timer);
		},
	});
	return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
}
