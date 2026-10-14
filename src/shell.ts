// The HTML page that boots the client, built from the pinned build snapshot.
// Everything about the signed-in account is ours.

import type { User } from "./auth";
import { loadBuild } from "./build";
import { settings } from "./settings";
import { TIDY_SCRIPT, hideCss, tidyData } from "./tidy";
import { FLAG_PICKER_CSS, FLAG_PICKER_SCRIPT, flagPickerData } from "./flag-picker";
import { PUBLIC_ORIGIN } from "./config";
import { legacyUser } from "./model";
import { patchText } from "./patch";

// account settings as the client expects them
export function settingsFor(user: User): Record<string, unknown> {
	return {
		display_sensitive_media: false,
		protected: false,
		screen_name: user.screen_name,
		always_use_https: true,
		use_cookie_personalization: false,
		sleep_time: { enabled: false, end_time: null, start_time: null },
		geo_enabled: false,
		language: "en",
		discoverable_by_email: false,
		discoverable_by_mobile_phone: false,
		personalized_trends: false,
		allow_media_tagging: "all",
		allow_contributor_request: "none",
		allow_ads_personalization: false,
		allow_logged_out_device_personalization: false,
		allow_location_history_personalization: false,
		allow_sharing_data_for_third_party_personalization: false,
		allow_dms_from: "following",
		always_allow_dms_from_subscribers: null,
		allow_dm_groups_from: "following",
		translator_type: "none",
		country_code: "us",
		nsfw_user: false,
		nsfw_admin: false,
		ranked_timeline_setting: null,
		ranked_timeline_eligible: null,
		address_book_live_sync_enabled: false,
		universal_quality_filtering_enabled: "enabled",
		dm_receipt_setting: "all_enabled",
		alt_text_compose_enabled: null,
		mention_filter: "unfiltered",
		allow_authenticated_periscope_requests: false,
		protect_password_reset: false,
		require_password_login: false,
		requires_login_verification: false,
		ext_dm_av_call_settings: {
			has_av_calls_enabled: false,
			av_call_permissions: {
				accept_calls_from_addressbook: false,
				accept_calls_from_following: false,
				accept_calls_from_verified: false,
				accept_calls_from_everyone: false,
			},
		},
		ext_sharing_audiospaces_listening_data_with_followers: false,
		dm_quality_filter: "enabled",
		autoplay_disabled: false,
		settings_metadata: {},
	};
}

// The instance's logo over the client's X in the side bar: the X alone when the
// bar is narrow, the word mark when it is wide. The bar's width depends on the
// window and on the page (Chat keeps it narrow), so tidy.ts measures it and sets
// data-wide-nav on <html>. The client marks its dark themes with color-scheme on <html>.
const LOGO = 'header h1 a[aria-label="X"]';
const DARK = 'html[style*="color-scheme: dark"]';
const WIDE = "html[data-wide-nav]";
// the X drawn at the top of the sign-in dialog, known by its path
const DIALOG_LOGO = '[role="dialog"] span:has(> svg > path[d^="M21.742 21.75l-7.563-11.179"])';
const LOGO_CSS = `${LOGO} svg{opacity:0}
${LOGO}{background:url(/public/icon-light.png) center/36px no-repeat}
${DARK} ${LOGO}{background-image:url(/public/icon-dark.png)}
${WIDE} ${LOGO}{width:150px;background-image:url(/public/logo-light.png);background-size:128px auto;background-position:10px center}
${WIDE}${DARK} ${LOGO}{background-image:url(/public/logo-dark.png)}
${DIALOG_LOGO}{background:url(/public/icon-light.png) center/contain no-repeat}
${DARK} ${DIALOG_LOGO}{background-image:url(/public/icon-dark.png)}
${DIALOG_LOGO} svg{opacity:0}`;

// Paid features the client gates on a per-account claim. Nothing is paid for
// here, so every account holds them.
const CLAIMED_FEATURES = Object.fromEntries(["subscriptions_feature_article_composer"].map((k) => [k, { value: "true" }]));

// Switches whose values name x.com hosts. The client checks them against host
// lists that patch.ts has already rewritten, so the captured value would fail;
// without the switch the client falls back to its (patched) default.
const HOST_SWITCHES = ["responsive_web_media_upload_host"];
const withoutHostSwitches = (config: Record<string, unknown>) =>
	Object.fromEntries(Object.entries(config ?? {}).filter(([k]) => !HOST_SWITCHES.includes(k)));

function initialState(user: User, fs: NonNullable<ReturnType<typeof loadBuild>>["build"]["featureSwitch"]) {
	return {
		optimist: [],
		entities: {
			users: { entities: { [user.id]: legacyUser(user) }, errors: {}, fetchStatus: { [user.id]: "loaded" } },
		},
		featureSwitch: {
			defaultConfig: withoutHostSwitches(fs.defaultConfig),
			user: { config: withoutHostSwitches(fs.config), impression_pointers: {}, impressions: {}, keysRead: {}, settingsVersion: fs.settingsVersion },
			debug: {},
			featureSetToken: fs.featureSetToken,
			isLoaded: true,
			isLoading: false,
			customOverrides: {},
		},
		settings: {
			local: {
				nextPushCheckin: 0,
				shouldAutoPlayGif: false,
				scale: "normal",
				themeColor: "blue500",
				highContrastEnabled: false,
				loginPromptLastShown: 0,
				moneyNotificationsLastSeenSortIndex: {},
				reducedMotionEnabled: false,
				showTweetMediaDetailDrawer: true,
				autoPollNewTweets: false,
				shouldAutoTagLocation: false,
				replyVotingSurveyClicked: 0,
				pushNotificationsPermission: null,
				quoteVideoToggleUsed: false,
			},
			remote: { settings: settingsFor(user), fetchStatus: "loaded" },
			dataSaver: { dataSaverMode: false },
			transient: { loginPromptShown: false, lastViewedDmInboxPath: "/messages", themeFocus: null, notificationsType: null },
		},
		devices: {
			browserPush: { fetchStatus: "none", pushNotificationsPrompt: { dismissed: false, fetchStatus: "none" }, subscribed: false, supported: null },
			devices: { data: { emails: [], phone_numbers: [] }, fetchStatus: "none" },
			notificationSettings: {
				push_settings: { error: null, fetchStatus: "none" },
				push_settings_template: { template: { settings: [] } },
				checkin_time: null,
			},
		},
		educationFlags: {},
		userClaim: { config: { subscriptions: {}, features: CLAIMED_FEATURES }, commerceSubscriptions: [], debug: {}, fetchStatus: "loaded" },
		session: {
			communitiesActions: { create: false },
			country: "US",
			guestId: "",
			hasCommunityMemberships: false,
			isActiveCreator: false,
			isLoaded: true,
			isRestrictedSession: false,
			language: "en",
			ssoInitTokens: {},
			superFollowersCount: 0,
			superFollowsApplicationStatus: "NotStarted",
			user_id: user.id,
			userFeatures: {},
			xpaymentsEnrolled: false,
			canAccessPayments: false,
			isSuperFollowSubscriber: false,
		},
		developer: { dtabBarInfo: { hide: true } },
	};
}

const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

// JSON placed inside a <script> must not be able to close it
const inline = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");

let runtimePatched: string | undefined;

export function shell(user: User): string | undefined {
	const loaded = loadBuild();
	if (!loaded) return undefined;
	const { build, runtime } = loaded;
	runtimePatched ??= patchText(runtime);
	const meta = { ...build.meta, sha: build.sha, isLoggedIn: true, userId: user.id, serverDate: Date.now() };
	const scripts = build.scripts
		.map((p) => `<script defer charset="utf-8" crossorigin="anonymous" src="${PUBLIC_ORIGIN}/abs${p}"></script>`)
		.join("");
	return `<!DOCTYPE html><html dir="ltr" lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=0,viewport-fit=cover" />
<meta name="theme-color" content="#000000" /><title>${esc(settings().instance_name)}</title>
<link rel="icon" type="image/png" href="/public/favicon.png" /><link rel="apple-touch-icon" href="/public/icon-light.png" />
<style>html,body{height:100%}body{margin:0;background-color:#000;overflow-y:scroll}${LOGO_CSS}
${hideCss()}
${FLAG_PICKER_CSS}</style>
</head><body><div id="react-root" style="height:100%;display:flex;"></div>
<script>window.__INITIAL_STATE__=${inline(initialState(user, build.featureSwitch))};window.__META_DATA__=${inline(meta)};</script>
<script>window.__XITTER__=${inline({ ...flagPickerData(user.flag), tidy: tidyData() })};
${TIDY_SCRIPT}
${FLAG_PICKER_SCRIPT}</script>
<script id="nonce-csp"></script>
<script>${runtimePatched}</script>
${scripts}
</body></html>`;
}
