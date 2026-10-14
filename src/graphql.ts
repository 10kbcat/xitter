// GraphQL operations, routed by name. The client sends a query id that changes
// with every build; the name after it is stable.

import { sql } from "./db";
import { blockedIds } from "./blocks";
import { rankedFeed } from "./ranking";
import * as articles from "./articles";
import type { Viewer } from "./auth";
import { notificationsTimeline, unreadCount } from "./notifications";
import { searchPosts, searchUsers, trendingHashtags } from "./search";
import { isId, newId } from "./ids";
import { attachMedia } from "./media";
import { cursorEntry, feedEntry, gridAppend, gridEntry, pinnedEntry, replyEntry, tweetEntry, tweetResult, userEntry, userResult } from "./model";
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
	postsByIds,
	replies,
	repost,
	setMark,
	setPinned,
	unrepost,
} from "./posts";
import { affiliatesOf, followList, userById, userByName, usersByIds } from "./users";

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

const homeResponse = (entries: unknown[]) => ({
	data: {
		home: {
			home_timeline_urt: {
				instructions: [{ type: "TimelineAddEntries", entries }],
				metadata: { scribeConfig: { page: "following" } },
			},
		},
	},
});

// "For you" is ranked (ranking.ts) and takes in everyone; "Following" is the
// viewer and the accounts they follow, newest first.
// A ranked page's bottom cursor is "r<offset>.<asOf>", where asOf is the item id
// the ranking was made at. Its top cursor is "t<asOf>": the client's poll for
// newer posts gets what arrived since, newest first, above the ranked entries.
const forYou: Handler = async (viewer, vars) => {
	const cursor = typeof vars.cursor === "string" ? vars.cursor : "";
	const ranked = /^r(\d+)\.(\d{1,19})$/.exec(cursor);
	if (cursor && !ranked) return home(false)(viewer, vars);
	const count = Math.min(Math.max(Number(vars.count) || 20, 1), 100);
	const asOf = ranked ? ranked[2] : newId();
	const offset = ranked ? Number(ranked[1]) : 0;
	const page = await rankedFeed(viewer.id, { asOf, offset, limit: count });
	// sort indexes run down from asOf in ranked order, below anything newer
	const base = BigInt(asOf);
	const entries: unknown[] = page.items.map((item, i) => feedEntry(item, (base - BigInt(offset + i) - 1n).toString()));
	if (!ranked) entries.unshift(cursorEntry("Top", `t${asOf}`, inc(asOf)));
	if (page.next !== undefined) entries.push(cursorEntry("Bottom", `r${page.next}.${asOf}`, (base - BigInt(page.next) - 1n).toString()));
	return homeResponse(entries);
};

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
	(withReplies: boolean, kinds: "both" | "posts" | "reposts", onlyReplies = false, articlesOnly = false): Handler =>
	async (viewer, vars) => {
		const { count, at, newer } = pageOf(vars);
		// profile tabs only page downwards
		if (newer) return userTimeline([]);
		const owner = userId(vars);
		const items = await feed({ viewerId: viewer.id, authors: { user: owner }, replies: withReplies, onlyReplies, articlesOnly, kinds, limit: count, before: at });
		let pinned: Awaited<ReturnType<typeof getPost>>;
		if (!at && !withReplies && kinds === "both" && !articlesOnly) {
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

// the Media tabs: the account's own posts with media, as a grid
const userMedia =
	(media: "any" | "photo" | "video"): Handler =>
	async (viewer, vars) => {
		const { count, at, newer } = pageOf(vars);
		if (newer) return userTimeline([]);
		const items = await feed({ viewerId: viewer.id, authors: { user: userId(vars) }, replies: true, kinds: "posts", media, limit: count, before: at });
		const posts = items.map((i) => i.post);
		const cursors: unknown[] = [];
		if (items.length) {
			if (!at) cursors.push(cursorEntry("Top", `t${items[0].id}`, inc(items[0].id)));
			const last = items[items.length - 1].id;
			cursors.push(cursorEntry("Bottom", `b${last}`, dec(last)));
		}
		if (!at) return userTimeline([...(posts.length ? [gridEntry(posts, items[0].id)] : []), ...cursors]);
		const result = userTimeline(cursors);
		if (posts.length) result.data.user.result.timeline.timeline.instructions.unshift(gridAppend(posts) as any);
		return result;
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

// Settings > Privacy > Blocked and Muted accounts; both lists come back whole
const relationList =
	(kind: "blocks" | "mutes" | "none"): Handler =>
	async (viewer, vars) => {
		const ids = vars.cursor || kind === "none" ? [] : await blockedIds(viewer.id, kind);
		const users = await usersByIds(viewer.id, ids);
		const base = BigInt(newId());
		const entries = ids.flatMap((id, i) => (users.has(id) ? [userEntry(users.get(id)!, (base - BigInt(i) - 1n).toString())] : []));
		const timeline = { timeline: { instructions: [{ type: "TimelineAddEntries", entries: wholeList(entries, base) }] } };
		return { data: { viewer: kind === "mutes" ? { muting_timeline: timeline } : { timeline } } };
	};

const viewerUser = (fields: object) => ({ data: { viewer: { user_results: { result: { __typename: "User", ...fields } } } } });

const handlers: Record<string, Handler> = {
	HomeTimeline: forYou,
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

	NotificationsTimeline: (v, vars) =>
		notificationsTimeline(v, { type: String(vars.timeline_type ?? "All"), count: Number(vars.count) || 20, cursor: typeof vars.cursor === "string" ? vars.cursor : undefined }),
	TweetResultsByRestIds: async (v, vars) => {
		const ids = Array.isArray(vars.tweetIds) ? (vars.tweetIds as unknown[]).map(String).filter(isId).slice(0, 100) : [];
		const posts = await Promise.all(ids.map((id) => getPost(v.id, id)));
		return { data: { tweetResult: posts.map((p) => (p ? { result: tweetResult(p) } : {})) } };
	},
	TweetResultByRestId: async (v, vars) => {
		const post = await getPost(v.id, postId(vars, "tweetId"));
		return { data: post ? { tweetResult: { result: tweetResult(post) } } : {} };
	},

	UserByScreenName: async (v, vars) => {
		const user = typeof vars.screen_name === "string" ? await userByName(v.id, vars.screen_name) : undefined;
		// an empty answer makes the client show "this account doesn't exist"
		if (!user) return { data: {} };
		if (user.status === "suspended" && !v.role) return { data: { user: { result: { __typename: "UserUnavailable", reason: "Suspended", message: "This account is suspended." } } } };
		return { data: { user: { result: userResult(user) } } };
	},
	// "About this account" (/<name>/about)
	AboutAccountQuery: async (v, vars) => {
		const user = typeof vars.screenName === "string" ? await userByName(v.id, vars.screenName) : undefined;
		if (!user || (user.status === "suspended" && !v.role))
			return { data: { user_result_by_screen_name: { result: { __typename: "UserUnavailable", unavailable_reason: user ? "Suspended" : "NotFound" } } } };
		const [extra] = await sql`select u.verified_at,
			(select count(*)::int from username_changes c where c.user_id = u.id) as changes,
			(select max(c.changed_at) from username_changes c where c.user_id = u.id) as last_change
			from users u where u.id = ${user.id}::bigint`;
		const base = userResult(user);
		return {
			data: {
				user_result_by_screen_name: {
					result: {
						...base,
						rest_id: user.id,
						identity_profile_labels_highlighted_label: base.affiliates_highlighted_label,
						about_profile: {
							affiliate_username: user.org?.screen_name ?? null,
							username_changes: { count: String(extra.changes), ...(extra.last_change ? { last_changed_at_msec: String(extra.last_change.getTime()) } : {}) },
						},
						verification_info: {
							is_identity_verified: false,
							...(user.verified_type && extra.verified_at ? { reason: { verified_since_msec: String(extra.verified_at.getTime()) } } : {}),
						},
					},
				},
			},
		};
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
	// the account menu's badges and avatars for the other signed-in accounts
	UsersVerifiedAvatars: async (v, vars) => {
		const ids: unknown[] = Array.isArray(vars.userIds) ? vars.userIds.slice(0, 10) : [];
		const users = await Promise.all(ids.filter(isId).map((id) => userById(v.id, id)));
		return { data: { usersResults: users.filter((u) => u !== undefined).map((u) => ({ result: userResult(u) })) } };
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
	BlockedAccountsAll: relationList("blocks"),
	BlockedAccountsImported: relationList("none"),
	MutedAccounts: relationList("mutes"),
	// an organisation's Affiliates tab
	UserBusinessProfileTeamTimeline: async (viewer, vars) => {
		const users = vars.cursor ? [] : await affiliatesOf(viewer.id, userId(vars));
		const base = BigInt(newId());
		return userTimeline(wholeList(users.map((u, i) => userEntry(u, (base - BigInt(i) - 1n).toString())), base));
	},
	Following: follows("following"),
	Followers: follows("followers"),
	UserMedia: userMedia("any"),
	UserPhotoTimeline: userMedia("photo"),
	UserVideoTimeline: userMedia("video"),
	UserRepliesTimeline: profileFeed(true, "posts", true),
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
	ViewerBadgeCounts: async (v) => ({
		data: {
			viewer_v2: {
				user_results: {
					result: {
						__typename: "User",
						badge_counts: await (async () => {
							const n = await unreadCount(v.id);
							return { dm_unread_count: 0, is_from_urt: true, ntab_unread_count: n, total_unread_count: n, xchat_unread_count: 0 };
						})(),
					},
				},
			},
		},
	}),
	DataSaverMode: () => ({ data: { viewer: {} } }),
	PinnedTimelines: () => ({ data: { pinned_timelines: { pinned_timelines: [] } } }),
	CreatorStudioTabBarItemQuery: () => ({ data: { xpayments_audience_rewards_tasks: [] } }),
	SidebarUserRecommendations: () => ({ data: { sidebar_user_recommendations: [] } }),
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

// articles: the editor's operations, the redirect from /i/article/<id> and the profile tab
const articleId = (vars: Vars, key = "articleEntityId") => {
	const id = vars[key];
	if (!isId(id)) throw new PostError("Article not found.", 34);
	return id;
};
// the editor and its preview render a published article through its post,
// so the post goes into the article's metadata in full
async function withPost<T extends articles.ArticleEntity | undefined>(viewerId: string, article: T): Promise<T> {
	const ref = article?.metadata?.tweet_results;
	if (!ref) return article;
	const post = await getPost(viewerId, ref.rest_id);
	if (post) ref.result = tweetResult(post) as any;
	return article;
}

const articleHandlers: Record<string, Handler> = {
	ArticleEntityDraftCreate: async (v, vars) => ({
		data: { articleentity_create_draft: { article_entity_results: { result: await withPost(v.id, await articles.createDraft(v.id, vars.title, vars.content_state)) } } },
	}),
	ArticleEntityResultByRestId: async (v, vars) => {
		const article = await withPost(v.id, await articles.getArticle(v.id, articleId(vars)));
		return { data: article ? { article_result_by_rest_id: { result: article } } : {} };
	},
	ArticleRedirectScreenQuery: async (v, vars) => {
		const article = await articles.getArticle(v.id, articleId(vars), false);
		return { data: { article_result_by_rest_id: article ? { result: article } : {} } };
	},
	ArticleEntityUpdateTitle: async (v, vars) => ({ data: { articleentity_update_title: await withPost(v.id, await articles.updateTitle(v.id, articleId(vars), vars.title)) } }),
	ArticleEntityUpdateContent: async (v, vars) => ({
		data: { articleentity_update_content_state: await withPost(v.id, await articles.updateContent(v.id, articleId(vars, "article_entity"), vars.content_state)) },
	}),
	ArticleEntityUpdateCoverMedia: async (v, vars) => ({
		data: { articleentity_update_cover_media: await withPost(v.id, await articles.updateCover(v.id, articleId(vars), (vars.coverMedia as any)?.media_id)) },
	}),
	ArticleEntityPublish: async (v, vars) => {
		const text = typeof vars.tweetText === "string" ? vars.tweetText : "";
		if ([...text].length > MAX_POST_LENGTH) throw new PostError(`Posts are limited to ${MAX_POST_LENGTH} characters.`, 186);
		const result = await withPost(v.id, await articles.publish(v.id, articleId(vars), text, (t, id) => createPost(v.id, t, { articleId: id })));
		return { data: { articleentity_publish: { article_entity_results: { result } } } };
	},
	ArticleEntityUnpublish: async (v, vars) => ({
		data: { articleentity_unpublish: { article_entity_results: { result: await articles.unpublish(v.id, articleId(vars)) } } },
	}),
	ArticleEntityDelete: async (v, vars) => {
		await articles.deleteArticle(v.id, articleId(vars));
		return { data: { articleentity_delete: "Done" } };
	},
	ArticleEntitiesSlice: async (v, vars) => {
		const owner = isId(vars.userId) ? vars.userId : v.id;
		const slice = await articles.slice(v.id, owner, String(vars.lifecycle ?? "Draft"), vars.cursor);
		const items = await Promise.all(slice.items.map((a) => withPost(v.id, a)));
		const next = slice.next;
		return {
			data: {
				user: {
					result: {
						__typename: "User",
						articles_article_mixer_slice: {
							items: items.map((result) => ({ article_entity_results: { result } })),
							slice_info: next ? { next_cursor: next } : {},
						},
					},
				},
			},
		};
	},
	UserArticlesTweets: profileFeed(false, "posts", false, true),
};
Object.assign(handlers, articleHandlers);

// Search results. Latest pages by post id ("b<id>"), Top and People by offset ("o<n>").
// Top starts with a few matching accounts, as on X.
const searchTimeline = (instructions: unknown[]) => ({ data: { search_by_raw_query: { search_timeline: { timeline: { instructions } } } } });

async function search(viewer: Viewer, vars: Vars) {
	const query = typeof vars.rawQuery === "string" ? vars.rawQuery.slice(0, 500) : "";
	const product = String(vars.product ?? "Top");
	const count = Math.min(Math.max(Number(vars.count) || 20, 1), 50);
	const cursor = typeof vars.cursor === "string" ? vars.cursor : "";
	if (cursor.startsWith("t")) return searchTimeline([]);
	const offset = /^o(\d{1,6})$/.exec(cursor) ? Number(cursor.slice(1)) : 0;
	const before = /^b(\d{1,19})$/.exec(cursor) ? cursor.slice(1) : undefined;
	const entries: unknown[] = [];
	const base = BigInt(newId());
	const sort = (i: number) => (base - BigInt(i) - 10n).toString();
	let next: string | undefined;

	if (product === "People") {
		const ids = await searchUsers(query, count, offset);
		const users = await usersByIds(viewer.id, ids);
		ids.forEach((id, i) => users.get(id) && entries.push(userEntry(users.get(id)!, sort(i))));
		if (ids.length === count) next = `o${offset + count}`;
	} else if (product === "Media") {
		const ids = await searchPosts(query, { viewerId: viewer.id, top: false, media: true, limit: count, before });
		const posts = await postsByIds(viewer.id, ids);
		const list = ids.map((id) => posts.get(id)).filter((p) => !!p);
		if (list.length) {
			if (before) {
				const last = ids[ids.length - 1];
				return searchTimeline([gridAppend(list, "search-grid-0"), { type: "TimelineAddEntries", entries: [cursorEntry("Bottom", `b${last}`, sort(count + 1))] }]);
			}
			entries.push(gridEntry(list, sort(0), "search-grid-0"));
		}
		if (ids.length === count) next = `b${ids[ids.length - 1]}`;
	} else if (product === "Latest" || product === "Top") {
		const top = product === "Top";
		if (top && !offset && !/(^|\s)-?\w+:/.test(query)) {
			const userIds = await searchUsers(query, 3);
			const users = await usersByIds(viewer.id, userIds);
			const items = userIds.map((id) => users.get(id)).filter((u) => !!u);
			if (items.length)
				entries.push({
					entryId: "toptabsrpusermodule-0",
					sortIndex: sort(0),
					content: {
						__typename: "TimelineTimelineModule",
						entryType: "TimelineTimelineModule",
						displayType: "Vertical",
						header: { displayType: "Classic", text: "People", sticky: false },
						footer: { displayType: "Classic", text: "View all", landingUrl: { url: `twitter://search/?query=${encodeURIComponent(query)}&src=typed_query&f=user`, urlType: "DeepLink" } },
						items: items.map((u) => ({ entryId: `toptabsrpusermodule-0-user-${u.id}`, item: userEntry(u, "0").content })),
					},
				});
		}
		const ids = await searchPosts(query, { viewerId: viewer.id, top, limit: count, before, offset });
		const posts = await postsByIds(viewer.id, ids);
		ids.forEach((id, i) => posts.get(id) && entries.push(tweetEntry(posts.get(id)!, sort(i + 1))));
		if (ids.length === count) next = top ? `o${offset + count}` : `b${ids[ids.length - 1]}`;
	}
	entries.push(cursorEntry("Top", `t${base}`, (base + 1n).toString()));
	entries.push(cursorEntry("Bottom", next ?? "end", sort(count + 1)));
	return searchTimeline([{ type: "TimelineAddEntries", entries }]);
}

const trendItem = (t: { tag: string; posts: number }, i: number) => ({
	__typename: "TimelineTrend",
	itemType: "TimelineTrend",
	name: t.tag,
	rank: String(i + 1),
	trend_url: { url: `twitter://search/?query=${encodeURIComponent(t.tag)}&src=trend_click&vertical=trends`, urlType: "DeepLink" },
	trend_metadata: { domain_context: "Trending", meta_description: `${t.posts} post${t.posts === 1 ? "" : "s"}` },
});

// Explore: hashtags used most in the last week, as trends
async function explorePage() {
	const trends = await trendingHashtags(7, 20);
	const base = BigInt(newId());
	const entries = trends.map((t, i) => ({
		entryId: `trend-${t.tag.slice(1)}`,
		sortIndex: (base - BigInt(i)).toString(),
		content: { __typename: "TimelineTimelineItem", entryType: "TimelineTimelineItem", itemContent: trendItem(t, i) },
	}));
	const timeline = { instructions: [{ type: "TimelineAddEntries", entries }] };
	return { data: { explore_page: { id: globalId("ExplorePage", "explore"), body: { __typename: "Timeline", timeline } } } };
}

// the "What's happening" box beside every page: the top few trends
async function exploreSidebar() {
	const trends = await trendingHashtags(7, 5);
	const id = newId();
	const entries = trends.length
		? [
				{
					entryId: `trend-${id}`,
					sortIndex: id,
					content: {
						__typename: "TimelineTimelineModule",
						entryType: "TimelineTimelineModule",
						displayType: "Vertical",
						header: { displayType: "Classic", text: "What’s happening" },
						footer: { displayType: "Classic", text: "Show more", landingUrl: { url: "twitter://explore", urlType: "DeepLink" } },
						items: trends.map((t, i) => ({ entryId: `trend-${id}-trend-${t.tag}`, item: { itemContent: trendItem(t, i) } })),
					},
				},
			]
		: [];
	const instructions = [{ type: "TimelineClearCache" }, { type: "TimelineAddEntries", entries }];
	return { data: { explore_sidebar: { timeline: { instructions, responseObjects: { feedbackActions: [] } } } } };
}

Object.assign(handlers, {
	SearchTimeline: (v: Viewer, vars: Vars) => search(v, vars),
	ExplorePage: () => explorePage(),
	ExploreSidebar: () => exploreSidebar(),
} satisfies Record<string, Handler>);

export const knownOperation = (name: string) => name in handlers;

export async function runOperation(name: string, viewer: Viewer, vars: Vars): Promise<Response> {
	try {
		return Response.json(await handlers[name](viewer, vars));
	} catch (e) {
		if (e instanceof PostError || e instanceof articles.ArticleError) return Response.json({ errors: [{ message: e.message, code: e.code }], data: {} });
		throw e;
	}
}
