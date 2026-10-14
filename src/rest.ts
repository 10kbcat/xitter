// The few REST endpoints the client still uses next to GraphQL.

import { type Viewer, clearedCookies, logout } from "./auth";
import { sql } from "./db";
import { isId } from "./ids";
import { legacyUser } from "./model";
import { settingsFor } from "./shell";
import { setFollow, userById } from "./users";

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
