// Builds the objects the client expects. Field sets follow the captured
// responses; fields for features we do not have are constants.

import type { User } from "./auth";
import { PUBLIC_ORIGIN } from "./config";

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

export function userResult(u: User) {
	return {
		__typename: "User",
		action_counts: { favorites_count: u.stats?.likes ?? 0 },
		affiliates_highlighted_label: {},
		avatar: { image_url: u.avatar_url ?? DEFAULT_AVATAR },
		...(u.banner_url ? { banner: { image_url: u.banner_url } } : {}),
		core: { created_at: apiDate(u.created_at), name: u.name, screen_name: u.screen_name },
		follow_request_sent: false,
		has_graduated_access: true,
		id: globalId("User", u.id),
		is_blue_verified: u.verified_type !== null,
		location: { location: u.location },
		media_permissions: { can_media_tag: true },
		notifications_settings: { notifications_enabled: false },
		parody_commentary_fan_label: "None",
		pinned_items: {},
		possibly_sensitive: false,
		privacy: { protected: false },
		profile_bio: { description: u.bio, entities: { description: {} } },
		profile_image_shape: u.verified_type === "business" ? "Square" : "Circle",
		profile_metadata: { profile_interstitial_type: "" },
		profile_translation: { translator_type: "none" },
		relationship_counts: { followers: u.stats?.followers ?? 0, following: u.stats?.following ?? 0 },
		relationship_perspectives: {
			blocked_by: false,
			blocking: false,
			followed_by: u.stats?.followsViewer ?? false,
			following: u.stats?.followedByViewer ?? false,
			live_following: false,
			muting: false,
		},
		rest_id: u.id,
		super_follow_eligible: false,
		super_followed_by: false,
		super_following: false,
		tweet_counts: { media_tweets: 0, tweets: u.stats?.posts ?? 0 },
		verification: verification(u),
		verified_user_profiles: { super_follows_user_profile: { is_active: false } },
		website: { url: "" },
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
		entities: { description: {} },
		profile_image_shape: u.verified_type === "business" ? "Square" : "Circle",
		profile_interstitial_type: "",
		is_translator: false,
		translator_type: "none",
		followers_count: u.stats?.followers ?? 0,
		friends_count: u.stats?.following ?? 0,
		media_count: 0,
		statuses_count: u.stats?.posts ?? 0,
		url: "",
		is_blue_verified: u.verified_type !== null,
		...(u.verified_type === "business" ? { verified_type: "Business" } : {}),
		...(u.verified_type === "government" ? { verified_type: "Government" } : {}),
		super_follow_eligible: false,
		super_followed_by: false,
		super_following: false,
		verified_user_profiles: { super_follows_user_profile: { is_active: false } },
		verified: false,
		protected: false,
		profile_image_url_https: u.avatar_url ?? DEFAULT_AVATAR,
		...(u.banner_url ? { profile_banner_url: u.banner_url } : {}),
		can_media_tag: true,
		follow_request_sent: false,
		description: u.bio,
		blocked_by: false,
		blocking: false,
		followed_by: u.stats?.followsViewer ?? false,
		following: u.stats?.followedByViewer ?? false,
		live_following: false,
		muting: false,
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
	created_at: Date;
	reply_user_id: string | null;
	reply_screen_name: string | null;
	like_count: number;
	repost_count: number;
	bookmark_count: number;
	reply_count: number;
	liked: boolean;
	reposted: boolean;
	bookmarked: boolean;
	author: User;
};

const EDIT_WINDOW_MS = 60 * 60 * 1000;

export function tweetResult(p: PostRow, withTypename = true) {
	return {
		...(withTypename ? { __typename: "Tweet" } : {}),
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
			entities: {},
			favorite_count: p.like_count,
			favorited: p.liked,
			full_text: p.text,
			id_str: p.id,
			...(p.reply_to_id && p.reply_user_id
				? {
						in_reply_to_screen_name: p.reply_screen_name,
						in_reply_to_status_id_str: p.reply_to_id,
						in_reply_to_user_id_str: p.reply_user_id,
					}
				: {}),
			is_quote_status: false,
			lang: "und",
			quote_count: 0,
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

const tweetItem = (p: PostRow) => ({
	__typename: "TimelineTweet",
	itemType: "TimelineTweet",
	tweetDisplayType: "Tweet",
	tweet_results: { result: tweetResult(p) },
});

export const tweetEntry = (p: PostRow, sortIndex: string) => ({
	content: { __typename: "TimelineTimelineItem", entryType: "TimelineTimelineItem", itemContent: tweetItem(p) },
	entryId: `tweet-${p.id}`,
	sortIndex,
});

// one reply shown as its own thread under the opened post
export const replyEntry = (p: PostRow, sortIndex: string) => ({
	content: {
		__typename: "TimelineTimelineModule",
		displayType: "VerticalConversation",
		entryType: "TimelineTimelineModule",
		items: [{ entryId: `conversationthread-${p.id}-tweet-${p.id}`, item: { itemContent: tweetItem(p) } }],
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
