// GraphQL operations, routed by name. The client sends a query id that changes
// with every build; the name after it is stable.

import type { Viewer } from "./auth";
import { isId, newId } from "./ids";
import { attachMedia } from "./media";
import { cursorEntry, feedEntry, pinnedEntry, replyEntry, tweetEntry, tweetResult, userEntry, userResult } from "./model";
import {
	MAX_POST_LENGTH,
	PostError,
	ancestors,
	bookmarkedPosts,
	createPost,
	deletePost,
	feed,
	getPost,
	likedPosts,
	replies,
	repost,
	setMark,
	setPinned,
	unrepost,
} from "./posts";
import { followList, userById, userByName } from "./users";

type Vars = Record<string, any>;
type Handler = (viewer: Viewer, vars: Vars) => Promise<unknown> | unknown;

const dec = (id: string) => (BigInt(id) - 1n).toString();
const inc = (id: string) => (BigInt(id) + 1n).toString();
const globalId = (kind: string, id: string) => Buffer.from(`${kind}:${id}`).toString("base64");

function postId(vars: Vars, key = "tweet_id"): string {
	const id = vars[key];
	if (!isId(id)) throw new PostError("Invalid post id.", 144);
	return id;
}

// Cursors are "b<id>" (older than) and "t<id>" (newer than), over feed item ids.
function pageOf(vars: Vars) {
	const count = Math.min(Math.max(Number(vars.count) || 20, 1), 100);
	const cursor = typeof vars.cursor === "string" ? vars.cursor : "";
	const at = isId(cursor.slice(1)) ? cursor.slice(1) : undefined;
	return { count, at, newer: cursor[0] === "t" && !!at };
}

// "For you" shows everyone; "Following" shows the viewer and the accounts they follow
const home =
	(following: boolean): Handler =>
	async (viewer, vars) => {
	const { count, at, newer } = pageOf(vars);
	const items = await feed({
		viewerId: viewer.id,
		authors: following ? { following: true } : { all: true },
		replies: false,
		kinds: "both",
		limit: count,
		...(newer ? { after: at } : { before: at }),
	});

	const entries: unknown[] = items.map((i) => feedEntry(i, i.id));
	const newest = items[0]?.id ?? at ?? newId();
	const oldest = items[items.length - 1]?.id ?? at ?? newest;
	// a poll for newer posts only moves the top cursor
	entries.unshift(cursorEntry("Top", `t${newest}`, inc(newest)));
	if (!newer) entries.push(cursorEntry("Bottom", `b${oldest}`, dec(oldest)));

	return {
		data: {
			home: {
				home_timeline_urt: {
					instructions: [{ type: "TimelineAddEntries", entries }],
					metadata: { scribeConfig: { page: "following" } },
				},
			},
		},
	};
};

const tweetDetail: Handler = async (viewer, vars) => {
	const id = postId(vars, "focalTweetId");
	const entries: unknown[] = [];
	// the whole conversation is returned at once, so a cursor request has nothing more
	if (!vars.cursor) {
		const focal = await getPost(viewer.id, id);
		if (!focal) throw new PostError("No status found with that ID.", 144);
		const above = focal.reply_to_id ? await ancestors(viewer.id, focal.reply_to_id) : [];
		const below = await replies(viewer.id, id);
		let sort = BigInt(newId());
		for (const p of above) entries.push(tweetEntry(p, (sort--).toString()));
		entries.push(tweetEntry(focal, (sort--).toString()));
		for (const p of below) entries.push(replyEntry(p, (sort--).toString()));
	}
	return {
		data: {
			threaded_conversation_with_injections_v2: {
				instructions: [
					...(vars.cursor ? [] : [{ type: "TimelineClearCache" }]),
					{ type: "TimelineAddEntries", entries },
					{ type: "TimelineTerminateTimeline", direction: "Top" },
					{ type: "TimelineTerminateTimeline", direction: "Bottom" },
				],
				metadata: { scribeConfig: { page: "ranked_replies" } },
			},
		},
	};
};

const bookmarks: Handler = async (viewer, vars) => {
	const posts = vars.cursor ? [] : await bookmarkedPosts(viewer.id);
	const base = BigInt(newId());
	const entries: unknown[] = posts.map((p, i) => tweetEntry(p, (base - BigInt(i) - 1n).toString()));
	entries.push(cursorEntry("Top", "t0", base.toString()));
	entries.push(cursorEntry("Bottom", "b0", (base - BigInt(posts.length) - 2n).toString()));
	return {
		data: { bookmark_timeline_v2: { timeline: { instructions: [{ type: "TimelineAddEntries", entries }], responseObjects: {} } } },
	};
};

const createTweet: Handler = async (viewer, vars) => {
	const text = typeof vars.tweet_text === "string" ? vars.tweet_text.trim() : "";
	const mediaIds: string[] = (Array.isArray(vars.media?.media_entities) ? vars.media.media_entities : [])
		.map((m: any) => String(m?.media_id ?? ""))
		.filter(isId);
	if (!text && !mediaIds.length) throw new PostError("Your post is empty.", 170);
	if ([...text].length > MAX_POST_LENGTH) throw new PostError(`Posts are limited to ${MAX_POST_LENGTH} characters.`, 186);
	const replyTo = vars.reply?.in_reply_to_tweet_id;
	if (replyTo !== undefined && !isId(replyTo)) throw new PostError("Invalid post id.", 144);
	// a quote arrives as a link to the quoted post
	const quoteId = typeof vars.attachment_url === "string" ? /\/status(?:es)?\/(\d{1,19})/.exec(vars.attachment_url)?.[1] : undefined;
	const id = await createPost(viewer.id, text, { replyToId: replyTo, quoteId });
	if (mediaIds.length) await attachMedia(viewer.id, id, mediaIds);
	const post = await getPost(viewer.id, id);
	return { data: { create_tweet: { tweet_results: { result: tweetResult(post!, false) } } } };
};

// every profile tab is read from the same place in the response
const userTimeline = (entries: unknown[]) => ({
	data: {
		user: {
			result: {
				__typename: "User",
				timeline: {
					timeline: {
						instructions: [{ type: "TimelineAddEntries", entries }],
						metadata: { scribeConfig: { page: "profileBest" } },
					},
				},
			},
		},
	},
});

function userId(vars: Vars): string {
	if (!isId(vars.userId)) throw new PostError("Invalid user id.", 50);
	return vars.userId;
}

// Profile tabs: posts and reposts, with or without replies, or reposts only.
// The pinned post leads the posts tab on the first page.
const profileFeed =
	(withReplies: boolean, kinds: "both" | "reposts"): Handler =>
	async (viewer, vars) => {
		const { count, at, newer } = pageOf(vars);
		// profile tabs only page downwards
		if (newer) return userTimeline([]);
		const owner = userId(vars);
		const items = await feed({ viewerId: viewer.id, authors: { user: owner }, replies: withReplies, kinds, limit: count, before: at });
		let pinned: Awaited<ReturnType<typeof getPost>>;
		if (!at && !withReplies && kinds === "both") {
			const user = await userById(viewer.id, owner);
			pinned = user?.pinned_post_id ? await getPost(viewer.id, user.pinned_post_id) : undefined;
		}
		// the labelled pinned entry goes first; its regular copy would be a duplicate id
		const entries: unknown[] = items.filter((i) => i.id !== pinned?.id).map((i) => feedEntry(i, i.id));
		if (pinned) entries.unshift(pinnedEntry(pinned, inc(BigInt(newId()).toString())));
		if (items.length) {
			if (!at) entries.unshift(cursorEntry("Top", `t${items[0].id}`, inc(items[0].id)));
			const last = items[items.length - 1].id;
			entries.push(cursorEntry("Bottom", `b${last}`, dec(last)));
		}
		return userTimeline(entries);
	};

// lists that are returned whole: a cursor request has nothing more
const wholeList = (entries: unknown[], base: bigint) => [
	...entries,
	cursorEntry("Top", "t0", (base + 1n).toString()),
	cursorEntry("Bottom", "b0", (base - BigInt(entries.length) - 2n).toString()),
];

const likes: Handler = async (viewer, vars) => {
	const posts = vars.cursor ? [] : await likedPosts(viewer.id, userId(vars));
	const base = BigInt(newId());
	return userTimeline(wholeList(posts.map((p, i) => tweetEntry(p, (base - BigInt(i) - 1n).toString())), base));
};

const follows =
	(kind: "following" | "followers"): Handler =>
	async (viewer, vars) => {
		const users = vars.cursor ? [] : await followList(viewer.id, userId(vars), kind);
		const base = BigInt(newId());
		return userTimeline(wholeList(users.map((u, i) => userEntry(u, (base - BigInt(i) - 1n).toString())), base));
	};

const viewerUser = (fields: object) => ({ data: { viewer: { user_results: { result: { __typename: "User", ...fields } } } } });

const handlers: Record<string, Handler> = {
	HomeTimeline: home(false),
	HomeLatestTimeline: home(true),
	TweetDetail: tweetDetail,
	Bookmarks: bookmarks,
	CreateTweet: createTweet,
	DeleteTweet: async (v, vars) => {
		await deletePost(v.id, postId(vars));
		return { data: { delete_tweet: { tweet_results: {} } } };
	},
	FavoriteTweet: async (v, vars) => {
		await setMark("likes", v.id, postId(vars), true);
		return { data: { favorite_tweet: "Done" } };
	},
	UnfavoriteTweet: async (v, vars) => {
		await setMark("likes", v.id, postId(vars), false);
		return { data: { unfavorite_tweet: "Done" } };
	},
	CreateBookmark: async (v, vars) => {
		await setMark("bookmarks", v.id, postId(vars), true);
		return { data: { tweet_bookmark_put: "Done" } };
	},
	DeleteBookmark: async (v, vars) => {
		await setMark("bookmarks", v.id, postId(vars), false);
		return { data: { tweet_bookmark_delete: "Done" } };
	},
	CreateRetweet: async (v, vars) => {
		const id = await repost(v.id, postId(vars));
		return { data: { create_retweet: { retweet_results: { result: { rest_id: id } } } } };
	},
	DeleteRetweet: async (v, vars) => {
		const id = postId(vars, "source_tweet_id");
		await unrepost(v.id, id);
		return { data: { unretweet: { source_tweet_results: { result: { rest_id: id } } } } };
	},

	TweetResultByRestId: async (v, vars) => {
		const post = await getPost(v.id, postId(vars, "tweetId"));
		return { data: post ? { tweetResult: { result: tweetResult(post) } } : {} };
	},

	UserByScreenName: async (v, vars) => {
		const user = typeof vars.screen_name === "string" ? await userByName(v.id, vars.screen_name) : undefined;
		// an empty answer makes the client show "this account doesn't exist"
		return { data: user ? { user: { result: userResult(user) } } : {} };
	},
	UserByRestId: async (v, vars) => {
		const user = await userById(v.id, userId(vars));
		return { data: user ? { user: { result: userResult(user) } } : {} };
	},
	UsersByRestIds: async (v, vars) => {
		const ids: unknown[] = Array.isArray(vars.userIds) ? vars.userIds.slice(0, 100) : [];
		const users = await Promise.all(ids.filter(isId).map((id) => userById(v.id, id)));
		return { data: { users: users.filter((u) => u !== undefined).map((u) => ({ result: userResult(u) })) } };
	},
	UserTweets: profileFeed(false, "both"),
	UserRepostsTimeline: profileFeed(false, "reposts"),
	PinTweet: async (v, vars) => {
		if (!(await setPinned(v.id, postId(vars)))) throw new PostError("You can only pin your own posts.", 144);
		return { data: { pin_one_tweet: { result: "Done" } } };
	},
	UnpinTweet: async (v) => {
		await setPinned(v.id, null);
		return { data: { unpin_one_tweet: { result: "Done" } } };
	},
	// what the posts tab of this build actually requests
	UserOriginalsTimeline: profileFeed(false, "both"),
	UserTweetsAndReplies: profileFeed(true, "both"),
	Likes: likes,
	Following: follows("following"),
	Followers: follows("followers"),
	UserMedia: () => userTimeline([]),
	UserHighlightsTweets: () => userTimeline([]),

	// features that do not exist here: valid empty answers so the client stays quiet
	ProfileSpotlightsQuery: () => ({ data: {} }),
	UserSportsProfile: () => ({ data: {} }),
	// own-profile analytics widget; it reads data.result.result and throws on null
	useFetchAnalyticsQuery: (v, vars) => ({
		data: {
			result: {
				result: {
					__typename: "User",
					id: globalId("User", v.id),
					free_metrics_rollup: (Array.isArray(vars.requested_metrics) ? vars.requested_metrics : []).map((metric_type: string) => ({
						metric_type,
						metric_value: 0,
					})),
				},
			},
		},
	}),
	isEligibleForVoButtonUpsellQuery: () => ({ data: {} }),
	usePremiumPaywallOnLoadMutation: () => ({ data: {} }),
	BookmarkFoldersSlice: () => viewerUser({ bookmark_collections_slice: { items: [], slice_info: {} } }),
	ViewerBadgeCounts: () => ({
		data: {
			viewer_v2: {
				user_results: {
					result: {
						__typename: "User",
						badge_counts: { dm_unread_count: 0, is_from_urt: true, ntab_unread_count: 0, total_unread_count: 0, xchat_unread_count: 0 },
					},
				},
			},
		},
	}),
	DataSaverMode: () => ({ data: { viewer: {} } }),
	PinnedTimelines: () => ({ data: { pinned_timelines: { pinned_timelines: [] } } }),
	CreatorStudioTabBarItemQuery: () => ({ data: { xpayments_audience_rewards_tasks: [] } }),
	SidebarUserRecommendations: () => ({ data: { sidebar_user_recommendations: [] } }),
	ExploreSidebar: () => ({ data: { explore_sidebar: { timeline: { instructions: [], responseObjects: { feedbackActions: [] } } } } }),
	useStoryTopicQuery: () => ({ data: { story_topic: { id: globalId("StoryTopic", "For You"), stories: { items: [] } } } }),
	useFetchProductSubscriptionsQuery: () => ({ data: { viewer_v2: { list_product_subscriptions: [] } } }),
	useSubscriptionsPaymentFailureQuery: (v) => ({
		data: {
			viewer_v2: {
				user_results: {
					id: globalId("UserResults", v.id),
					result: { __typename: "User", failed_payments: { failed_payments: [] }, id: globalId("User", v.id) },
				},
			},
		},
	}),
	NflScoresSidebarFollow: () => ({ data: { viewer: { user: { is_following_sports_league: { is_following: false } } } } }),
	SportsLeagueFollow: () => ({ data: { viewer: { user: { is_following_sports_league: { is_following: false } } } } }),
	FetchScheduledTweets: () => ({ data: { viewer: { scheduled_tweet_list: [] } } }),
	FetchDraftTweets: () => ({ data: { viewer: { draft_list: { response_data: [] } } } }),
	getAltTextPromptPreference: () => ({ data: {} }),
	grokAccountJwtQuery: () => ({ data: {} }),
};

export const knownOperation = (name: string) => name in handlers;

export async function runOperation(name: string, viewer: Viewer, vars: Vars): Promise<Response> {
	try {
		return Response.json(await handlers[name](viewer, vars));
	} catch (e) {
		if (e instanceof PostError) return Response.json({ errors: [{ message: e.message, code: e.code }], data: {} });
		throw e;
	}
}
