// Builds the objects the client expects. Field sets follow the captured
// responses; fields for features we do not have are constants.

import type { User } from "./auth";
import { PUBLIC_ORIGIN } from "./config";
import type { ArticleEntity } from "./articles";
import { FLAGS } from "./flags";
import { type MediaRow, absolute, mediaEntity } from "./media";
import { settings } from "./settings";

// a note's text with its links marked, as the note box and the note page expect
export function noteText(text: string) {
	const entities = [...text.matchAll(/https?:\/\/[^\s<>"']+/g)].map((m) => {
		const url = m[0].replace(/[.,;!?]+$/, "");
		return { fromIndex: m.index!, toIndex: m.index! + url.length, ref: { type: "TimelineUrl", url, expandedUrl: url, urlType: "ExternalUrl" } };
	});
	return { text, entities };
}

const DEFAULT_AVATAR = `${PUBLIC_ORIGIN}/abs/sticky/default_profile_images/default_profile_normal.png`;
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number) => String(n).padStart(2, "0");

// "Tue Oct 13 21:29:08 +0000 2026"
export function apiDate(d: Date): string {
	return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} +0000 ${d.getUTCFullYear()}`;
}

const globalId = (kind: string, id: string) => Buffer.from(`${kind}:${id}`).toString("base64");

function verification(u: User) {
	if (u.verified_type === "business") return { verified: false, verified_type: "Business" };
	if (u.verified_type === "government") return { verified: false, verified_type: "Government" };
	return { verified: false };
}

// the profile header shows the website from the bio's url entity
function urlEntities(u: User) {
	if (!u.website) return {};
	const display = u.website.replace(/^https?:\/\//, "").replace(/\/$/, "");
	return { url: { urls: [{ display_url: display, expanded_url: u.website, url: u.website, indices: [0, u.website.length] }] } };
}

// The badge after the name: an affiliate's organisation, which links to the
// organisation, or else the account's pride flag. There is room for one.
type Badge = { url: string; description: string; org?: string };

// Everything an account wears after its name, in order: its organisation's
// badge, its custom badges, its pride flag. X has one slot for it, which gets
// the first; the page script (badges.ts) draws the others after that one.
export function badgeList(u: User): Badge[] {
	const out: Badge[] = [];
	if (u.org) out.push({ url: absolute(u.org.avatar_url) ?? DEFAULT_AVATAR, description: u.org.name, org: u.org.screen_name });
	for (const b of u.badges ?? []) out.push({ url: `${PUBLIC_ORIGIN}/public/badge-${b.id}.png`, description: b.name });
	if (u.flag && FLAGS[u.flag]) out.push({ url: `${PUBLIC_ORIGIN}/public/flag-${u.flag}.svg`, description: `${FLAGS[u.flag].name} flag` });
	return out;
}

function badgeLabel(u: User) {
	const [first] = badgeList(u);
	if (!first) return {};
	return {
		label: {
			badge: { url: first.url },
			description: first.description,
			...(first.org ? { url: { url: `twitter://user?screen_name=${first.org}`, urlType: "DeepLink" } } : {}),
			userLabelType: "BusinessLabel",
			userLabelDisplayType: "Badge",
		},
	};
}

export function userResult(u: User) {
	return {
		__typename: "User",
		action_counts: { favorites_count: u.stats?.likes ?? 0 },
		affiliates_highlighted_label: badgeLabel(u),
		...(u.verified_type === "business" ? { business_account: { affiliates_count: u.affiliates ?? 0 } } : {}),
		avatar: { image_url: absolute(u.avatar_url) ?? DEFAULT_AVATAR },
		...(u.banner_url ? { banner: { image_url: absolute(u.banner_url) } } : {}),
		core: { created_at: apiDate(u.created_at), name: u.name, screen_name: u.screen_name },
		follow_request_sent: false,
		has_graduated_access: true,
		id: globalId("User", u.id),
		is_blue_verified: u.verified_type !== null,
		location: { location: u.location },
		media_permissions: { can_media_tag: true },
		notifications_settings: { notifications_enabled: false },
		parody_commentary_fan_label: "None",
		pinned_items: u.pinned_post_id ? { tweet_ids_str: [u.pinned_post_id] } : {},
		possibly_sensitive: false,
		privacy: { protected: false },
		profile_bio: { description: u.bio, entities: { description: {}, ...urlEntities(u) } },
		profile_image_shape: u.verified_type === "business" ? "Square" : "Circle",
		profile_metadata: { profile_interstitial_type: "" },
		profile_translation: { translator_type: "none" },
		relationship_counts: { followers: u.stats?.followers ?? 0, following: u.stats?.following ?? 0 },
		relationship_perspectives: {
			blocked_by: u.stats?.blockedBy ?? false,
			blocking: u.stats?.blocking ?? false,
			followed_by: u.stats?.followsViewer ?? false,
			following: u.stats?.followedByViewer ?? false,
			live_following: false,
			muting: u.stats?.muting ?? false,
		},
		rest_id: u.id,
		super_follow_eligible: false,
		super_followed_by: false,
		super_following: false,
		tweet_counts: { media_tweets: u.stats?.mediaPosts ?? 0, tweets: u.stats?.posts ?? 0 },
		user_seed_tweet_count: u.stats?.articles ?? 0,
		verification: verification(u),
		verified_user_profiles: { super_follows_user_profile: { is_active: false } },
		website: { url: u.website ?? "" },
	};
}

// older REST-style user record, used inside the page's initial state
export function legacyUser(u: User) {
	return {
		name: u.name,
		screen_name: u.screen_name,
		id_str: u.id,
		favourites_count: u.stats?.likes ?? 0,
		creator_subscriptions_count: 0,
		is_profile_translatable: false,
		location: u.location,
		notifications: false,
		possibly_sensitive: false,
		entities: { description: {}, ...urlEntities(u) },
		profile_image_shape: u.verified_type === "business" ? "Square" : "Circle",
		profile_interstitial_type: "",
		is_translator: false,
		translator_type: "none",
		followers_count: u.stats?.followers ?? 0,
		friends_count: u.stats?.following ?? 0,
		media_count: u.stats?.mediaPosts ?? 0,
		user_seed_tweet_count: u.stats?.articles ?? 0,
		statuses_count: u.stats?.posts ?? 0,
		url: u.website ?? "",
		pinned_tweet_ids_str: u.pinned_post_id ? [u.pinned_post_id] : [],
		is_blue_verified: u.verified_type !== null,
		...(u.verified_type === "business" ? { verified_type: "Business" } : {}),
		...(u.verified_type === "government" ? { verified_type: "Government" } : {}),
		super_follow_eligible: false,
		super_followed_by: false,
		super_following: false,
		verified_user_profiles: { super_follows_user_profile: { is_active: false } },
		verified: false,
		protected: false,
		profile_image_url_https: absolute(u.avatar_url) ?? DEFAULT_AVATAR,
		...(u.banner_url ? { profile_banner_url: absolute(u.banner_url) } : {}),
		can_media_tag: true,
		// with a default avatar and no bio or banner the client offers its "Set up
		// profile" onboarding flow, which we don't run; this keeps the Edit profile dialog
		default_profile_image: false,
		default_profile: false,
		follow_request_sent: false,
		description: u.bio,
		blocked_by: u.stats?.blockedBy ?? false,
		blocking: u.stats?.blocking ?? false,
		followed_by: u.stats?.followsViewer ?? false,
		following: u.stats?.followedByViewer ?? false,
		live_following: false,
		muting: u.stats?.muting ?? false,
		has_graduated_access: true,
		created_at: u.created_at.toISOString(),
		parody_commentary_fan_label: "None",
		can_dm: false,
	};
}

// a post joined with its author, counters and the viewer's own state
export type PostRow = {
	id: string;
	text: string;
	reply_to_id: string | null;
	conversation_id: string;
	quote_id: string | null;
	created_at: Date;
	source?: string;
	communityNote?: { id: string; text: string };
	sensitive?: boolean;
	reply_user_id: string | null;
	reply_screen_name: string | null;
	like_count: number;
	repost_count: number;
	bookmark_count: number;
	reply_count: number;
	quote_count: number;
	liked: boolean;
	reposted: boolean;
	bookmarked: boolean;
	author: User;
	media?: MediaRow[];
	article_id?: string | null;
	// accounts named with @ in the text
	mentions?: { id: string; screen_name: string; name: string }[];
	// the published article this post carries
	article?: ArticleEntity;
	// the post this one quotes, when it still exists
	quoted?: PostRow;
};

const EDIT_WINDOW_MS = 60 * 60 * 1000;

const permalink = (p: PostRow) => `${PUBLIC_ORIGIN}/${p.author.screen_name}/status/${p.id}`;

// @names in the text that belong to an account, with code point offsets as the client expects
function userMentions(p: PostRow) {
	if (!p.mentions?.length) return [];
	const byName = new Map(p.mentions.map((m) => [m.screen_name.toLowerCase(), m]));
	const out = [];
	for (const m of p.text.matchAll(/(?<![\w@])@(\w{1,15})/g)) {
		const user = byName.get(m[1].toLowerCase());
		if (!user) continue;
		const start = [...p.text.slice(0, m.index)].length;
		out.push({ id_str: user.id, indices: [start, start + 1 + m[1].length], name: user.name, screen_name: user.screen_name });
	}
	return out;
}

// #tags in the text; the client links each to a search for it
function hashtags(text: string) {
	// any script's letters (#привет), at least one letter, not glued to a word before it
	return [...text.matchAll(/(?<![\p{L}\p{N}_#&])#([\p{L}\p{N}_]*\p{L}[\p{L}\p{N}_]*)/gu)].map((m) => {
		const start = [...text.slice(0, m.index)].length;
		return { indices: [start, start + [...m[0]].length], text: m[1] };
	});
}

export function tweetResult(p: PostRow, withTypename = true): Record<string, unknown> {
	const textLength = [...p.text].length;
	const mentions = userMentions(p);
	const tags = hashtags(p.text);
	const media = (p.media ?? []).map((m, i) => mediaEntity(m, p.id, p.author.screen_name, i, textLength));
	const quoteLink = p.quoted && permalink(p.quoted);
	return {
		...(withTypename ? { __typename: "Tweet" } : {}),
		...(p.communityNote ? { has_birdwatch_notes: true, birdwatch_pivot: {
			title: "Readers added context they thought people might want to know", shorttitle: "Readers added context",
			subtitle: noteText(p.communityNote.text), iconType: "BirdwatchLevelHigh", footerIconType: "BirdwatchLevelHigh", visualStyle: "Default",
			destinationUrl: `/i/birdwatch/n/${p.communityNote.id}`, note: { rest_id: p.communityNote.id, language: "en", is_community_note_translatable: false, grok_translated_community_note_with_availability: { is_available: false } },
			footer: { text: `Context is written by people who use ${settings().instance_name}, and appears when rated helpful by others.`, entities: [] },
			callToAction: { destinationUrl: `/i/birdwatch/n/${p.communityNote.id}`, prompt: "Is this note helpful?", title: "Rate it" },
		} } : {}),
		...(p.quoted ? { quoted_status_result: { result: tweetResult(p.quoted) } } : {}),
		...(p.article ? { article: { article_results: { result: p.article } } } : {}),
		cashtag_attachments: [],
		core: { user_results: { result: userResult(p.author) } },
		edit_control: {
			edit_tweet_ids: [p.id],
			editable_until_msecs: String(p.created_at.getTime() + EDIT_WINDOW_MS),
			edits_remaining: "5",
			// editing is not implemented
			is_edit_eligible: false,
		},
		grok_analysis_button: false,
		grok_annotations: {},
		grok_translated_post_with_availability: { is_available: false },
		is_translatable: false,
		legacy: {
			bookmark_count: p.bookmark_count,
			bookmarked: p.bookmarked,
			conversation_id_str: p.conversation_id,
			created_at: apiDate(p.created_at),
			display_text_range: [0, [...p.text].length],
			entities: {
				...(media.length ? { media } : {}),
				...(mentions.length ? { user_mentions: mentions } : {}),
				...(tags.length ? { hashtags: tags } : {}),
			},
			...(media.length ? { extended_entities: { media } } : {}),
			favorite_count: p.like_count,
			favorited: p.liked,
			full_text: p.text,
			possibly_sensitive: !!p.sensitive,
			source: (p.source ?? "Xitter for Web").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!),
			id_str: p.id,
			...(p.reply_to_id && p.reply_user_id
				? {
						in_reply_to_screen_name: p.reply_screen_name,
						in_reply_to_status_id_str: p.reply_to_id,
						in_reply_to_user_id_str: p.reply_user_id,
					}
				: {}),
			is_quote_status: !!p.quote_id,
			...(p.quoted && quoteLink
				? {
						quoted_status_id_str: p.quoted.id,
						quoted_status_permalink: { url: quoteLink, expanded: quoteLink, display: quoteLink.replace(/^https?:\/\//, "") },
					}
				: {}),
			lang: "und",
			quote_count: p.quote_count,
			reply_count: p.reply_count,
			retweet_count: p.repost_count,
			retweeted: p.reposted,
			user_id_str: p.author.id,
		},
		rest_id: p.id,
		unmention_data: {},
		unmention_info: {},
		views: { state: "Enabled" },
	};
}

// A repost is its own post by the reposter: "RT @author: text" with the
// original nested inside, carrying the counters and viewer state of the original.
export function repostResult(id: string, by: User, createdAt: Date, original: PostRow) {
	const text = `RT @${original.author.screen_name}: ${original.text}`;
	return {
		__typename: "Tweet",
		cashtag_attachments: [],
		core: { user_results: { result: userResult(by) } },
		edit_control: { edit_tweet_ids: [id], editable_until_msecs: String(createdAt.getTime()), edits_remaining: "0", is_edit_eligible: false },
		grok_analysis_button: false,
		grok_annotations: {},
		grok_translated_post_with_availability: { is_available: false },
		is_translatable: false,
		legacy: {
			bookmark_count: original.bookmark_count,
			bookmarked: original.bookmarked,
			conversation_id_str: id,
			created_at: apiDate(createdAt),
			display_text_range: [0, [...text].length],
			entities: {
				user_mentions: [
					{
						id_str: original.author.id,
						indices: [3, 4 + original.author.screen_name.length],
						name: original.author.name,
						screen_name: original.author.screen_name,
					},
				],
			},
			favorite_count: original.like_count,
			favorited: original.liked,
			full_text: text,
			id_str: id,
			is_quote_status: false,
			lang: "und",
			quote_count: original.quote_count,
			reply_count: original.reply_count,
			retweet_count: original.repost_count,
			retweeted: original.reposted,
			retweeted_status_result: { result: tweetResult(original) },
			user_id_str: by.id,
		},
		rest_id: id,
		unmention_data: {},
		unmention_info: {},
		views: { state: "Enabled" },
	};
}

type SocialContext = { type: "TimelineGeneralContext"; contextType: string; text: string };

const tweetItem = (result: unknown, socialContext?: SocialContext, displayType = "Tweet") => ({
	__typename: "TimelineTweet",
	itemType: "TimelineTweet",
	tweetDisplayType: displayType,
	tweet_results: { result },
	...(socialContext ? { socialContext } : {}),
});

const itemEntry = (id: string, result: unknown, sortIndex: string, socialContext?: SocialContext) => ({
	content: { __typename: "TimelineTimelineItem", entryType: "TimelineTimelineItem", itemContent: tweetItem(result, socialContext) },
	entryId: `tweet-${id}`,
	sortIndex,
});

export const tweetEntry = (p: PostRow, sortIndex: string) => itemEntry(p.id, tweetResult(p), sortIndex);

// the client lifts an entry to the top of a profile only when it carries this label
export const pinnedEntry = (p: PostRow, sortIndex: string) =>
	itemEntry(p.id, tweetResult(p), sortIndex, { type: "TimelineGeneralContext", contextType: "Pin", text: "Pinned" });

// a post or a repost from feed(); entry ids are item ids, so both fit in one timeline
export const feedEntry = (item: { id: string; post: PostRow; repost?: { by: User; created_at: Date } }, sortIndex: string) =>
	item.repost ? itemEntry(item.id, repostResult(item.id, item.repost.by, item.repost.created_at, item.post), sortIndex) : tweetEntry(item.post, sortIndex);

// the Media tab: one grid module, later pages append to it
const GRID = "profile-grid-0";
const gridItems = (posts: PostRow[], grid: string) =>
	posts.map((p) => ({ entryId: `${grid}-tweet-${p.id}`, item: { itemContent: tweetItem(tweetResult(p), undefined, "MediaGrid") } }));
// grid is the module's id: the profile's media tab and search each have their own
export const gridEntry = (posts: PostRow[], sortIndex: string, grid = GRID) => ({
	content: {
		__typename: "TimelineTimelineModule",
		displayType: "VerticalGrid",
		entryType: "TimelineTimelineModule",
		items: gridItems(posts, grid),
	},
	entryId: grid,
	sortIndex,
});
export const gridAppend = (posts: PostRow[], grid = GRID) => ({ type: "TimelineAddToModule", moduleEntryId: grid, moduleItems: gridItems(posts, grid) });

// one reply shown as its own thread under the opened post
export const replyEntry = (p: PostRow, sortIndex: string) => ({
	content: {
		__typename: "TimelineTimelineModule",
		displayType: "VerticalConversation",
		entryType: "TimelineTimelineModule",
		items: [{ entryId: `conversationthread-${p.id}-tweet-${p.id}`, item: { itemContent: tweetItem(tweetResult(p)) } }],
		metadata: { conversationMetadata: { allTweetIds: [p.id], enableDeduplication: true } },
	},
	entryId: `conversationthread-${p.id}`,
	sortIndex,
});

export const cursorEntry = (type: "Top" | "Bottom", value: string, sortIndex: string) => ({
	content: { __typename: "TimelineTimelineCursor", cursorType: type, entryType: "TimelineTimelineCursor", value },
	entryId: `cursor-${type.toLowerCase()}-${sortIndex}`,
	sortIndex,
});

export const userEntry = (u: User, sortIndex: string) => ({
	content: {
		__typename: "TimelineTimelineItem",
		entryType: "TimelineTimelineItem",
		itemContent: { __typename: "TimelineUser", itemType: "TimelineUser", userDisplayType: "User", user_results: { result: userResult(u) } },
	},
	entryId: `user-${u.id}`,
	sortIndex,
});
