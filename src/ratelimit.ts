// Rate limits: fixed windows kept in memory, per account when signed in and per
// address when not. Over a limit the API answers like X (429, code 88, the
// x-rate-limit headers), which the client shows as its own "try again later".
// Staff are not limited. A restart clears every window.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Viewer } from "./auth";
import { CLIENT_DIR } from "./client-cache";
import { settings } from "./settings";

const MIN = 60_000;
// for development: the test scripts post far faster than a person
const OFF = process.env.RATE_LIMITS === "off";

type Rule = { limit: number; window: number };

// The per-account buckets take their limit from settings (Admin > Settings),
// so `limit` there is only the fallback.
export const RULES = {
	// any API call; a page load makes about 30
	read: { limit: 6000, window: 15 * MIN },
	// any write not covered below
	write: { limit: 1500, window: 15 * MIN },
	post: { limit: 150, window: 15 * MIN },
	// likes, reposts, bookmarks, follows and their undos
	engage: { limit: 1000, window: 15 * MIN },
	dm: { limit: 1500, window: 15 * MIN },
	// started uploads (each file's INIT), not its chunks
	upload: { limit: 150, window: 15 * MIN },
	// sign-in and sign-up screens, per address
	auth: { limit: 40, window: 15 * MIN },
	// password tries on one account, from anywhere
	password: { limit: 10, window: 15 * MIN },
	// codes and links mailed (sign-up, password reset), per address
	mail: { limit: 5, window: 60 * MIN },
} satisfies Record<string, Rule>;

export type Bucket = keyof typeof RULES;

type Window = { count: number; reset: number };
const windows = new Map<string, Window>();

setInterval(() => {
	const now = Date.now();
	for (const [k, w] of windows) if (w.reset <= now) windows.delete(k);
}, 5 * MIN).unref();

export type Hit = { ok: boolean; limit: number; remaining: number; reset: number };

// counts one request against `bucket` for `who` (an account id or an address)
export function hit(bucket: Bucket, who: string): Hit {
	const { window } = RULES[bucket];
	const set = (settings().rate_limits as Record<string, number>)[bucket];
	const limit = Number.isInteger(set) && set > 0 ? set : RULES[bucket].limit;
	if (OFF) return { ok: true, limit, remaining: limit, reset: Date.now() + window };
	const key = `${bucket}:${who}`;
	const now = Date.now();
	let w = windows.get(key);
	if (!w || w.reset <= now) windows.set(key, (w = { count: 0, reset: now + window }));
	// a refused request isn't counted: a client retrying while limited would
	// otherwise keep its window full for good
	if (w.count >= limit) {
		if (w.count === limit) {
			w.count++;
			console.log(`rate limit: ${bucket} used up by ${who} (${limit} per ${window / MIN} min)`);
		}
		return { ok: false, limit, remaining: 0, reset: w.reset };
	}
	w.count++;
	return { ok: true, limit, remaining: limit - w.count, reset: w.reset };
}

export const limitHeaders = (h: Hit) => ({
	"x-rate-limit-limit": String(h.limit),
	"x-rate-limit-remaining": String(h.remaining),
	"x-rate-limit-reset": String(Math.ceil(h.reset / 1000)),
});

export const limitedResponse = (h: Hit) =>
	Response.json({ errors: [{ code: 88, message: "Rate limit exceeded." }] }, { status: 429, headers: { ...limitHeaders(h), "retry-after": String(Math.max(1, Math.ceil((h.reset - Date.now()) / 1000))) } });

const POST_OPS = /^(CreateTweet|CreateNoteTweet|CreateScheduledTweet|CreateDraftTweet|ArticleEntityPublish)$/;
const ENGAGE_OPS = /^(FavoriteTweet|UnfavoriteTweet|CreateRetweet|DeleteRetweet|CreateBookmark|DeleteBookmark|bookmarkTweetToFolder|PinTweet|UnpinTweet)$/;
const ENGAGE_REST = /^\/1\.1\/(friendships\/(create|destroy)|favorites\/(create|destroy)|statuses\/(retweet|unretweet))/;
const DM_OPS = /XChat|SendMessageEvent|ConversationEvent/;
// what the client posts on its own all the time (event logging, its error
// reports, read markers): about 40 a minute, which would use up "write" in a
// quarter of an hour of reading
const BACKGROUND = /^\/(1\.1\/(jot|flow|graphql\/app_context|keyregistry)|2\/notifications\/[^/]+\/last_seen_cursor|xitter\/client_error|live_pipeline)/;
const BACKGROUND_OPS = /^(viewer_context\.json|app_context\.json|p2)$/;

// GraphQL reads the client sends as POST (HomeTimeline among them) aren't
// writes. The bundle names each operation's type; chunks arrive lazily from
// the CDN, so the folder is read again now and then.
const queries = new Set<string>();
async function readOperationTypes() {
	const dir = join(CLIENT_DIR, "abs", "responsive-web", "client-web");
	let files: string[] = [];
	try {
		files = (await readdir(dir)).filter((f) => f.endsWith(".js"));
	} catch {
		return;
	}
	for (const f of files) {
		const text = await readFile(join(dir, f), "utf8").catch(() => "");
		for (const m of text.matchAll(/operationName:"(\w+)",operationType:"query"/g)) queries.add(m[1]);
	}
}
readOperationTypes();
setInterval(readOperationTypes, 10 * MIN).unref();

// The buckets one API request counts against, beside "read" for every call.
export function bucketsFor(method: string, path: string, operation: string | undefined, url: URL): Bucket[] {
	if (/^\/(i|1\.1)\/media\/upload2?\.json$/.test(path)) return url.searchParams.get("command") === "INIT" ? ["upload"] : [];
	if (BACKGROUND.test(path) || (operation && BACKGROUND_OPS.test(operation))) return [];
	if (operation) {
		if (POST_OPS.test(operation)) return ["post"];
		if (ENGAGE_OPS.test(operation)) return ["engage"];
		if (DM_OPS.test(operation)) return method === "GET" ? [] : ["dm"];
		return method === "GET" || queries.has(operation) ? [] : ["write"];
	}
	if (ENGAGE_REST.test(path)) return ["engage"];
	return method === "GET" ? [] : ["write"];
}

// Counts an API request; a response when one of its limits is used up.
export function limitApi(viewer: Viewer, method: string, path: string, operation: string | undefined, url: URL): Response | undefined {
	if (viewer.role) return undefined;
	for (const bucket of ["read", ...bucketsFor(method, path, operation, url)] as Bucket[]) {
		const h = hit(bucket, viewer.id);
		if (!h.ok) return limitedResponse(h);
	}
}
