create table if not exists users (
	id bigint primary key,
	screen_name text not null,
	name text not null,
	password_hash text not null,
	bio text not null default '',
	location text not null default '',
	avatar_url text,
	banner_url text,
	-- null, 'blue', 'business' (gold) or 'government' (grey)
	verified_type text check (verified_type in ('blue', 'business', 'government')),
	created_at timestamptz not null default now()
);
create unique index if not exists users_screen_name_key on users (lower(screen_name));

create table if not exists sessions (
	token text primary key,
	user_id bigint not null references users (id) on delete cascade,
	csrf text not null,
	created_at timestamptz not null default now()
);

create table if not exists posts (
	id bigint primary key,
	user_id bigint not null references users (id) on delete cascade,
	text text not null,
	reply_to_id bigint references posts (id) on delete set null,
	conversation_id bigint not null,
	created_at timestamptz not null default now()
);
create index if not exists posts_reply_to_idx on posts (reply_to_id);
create index if not exists posts_user_idx on posts (user_id, id desc);

create table if not exists custom_badges (
	id bigint primary key, name text not null check(char_length(name) between 1 and 60),
	image bytea not null, mime text not null, created_at timestamptz not null default now()
);
-- an account's custom badges in order: the first fills X's badge slot after
-- the name (unless an organisation's does), the others are drawn after it
create table if not exists user_badges (
	user_id bigint not null references users(id) on delete cascade,
	badge_id bigint not null references custom_badges(id) on delete cascade,
	position integer not null default 0,
	primary key (user_id, badge_id)
);
create index if not exists user_badges_badge_idx on user_badges(badge_id);
-- accounts used to hold a single custom badge
do $$ begin
	if exists (select 1 from information_schema.columns where table_name = 'users' and column_name = 'custom_badge_id') then
		insert into user_badges (user_id, badge_id) select id, custom_badge_id from users where custom_badge_id is not null on conflict do nothing;
		alter table users drop column custom_badge_id;
	end if;
end $$;
alter table lists add column if not exists banner_media_id bigint;
-- the client's "seen this" popups: flag name -> timestamp
alter table users add column if not exists education_flags jsonb not null default '{}';
alter table users add column if not exists status_until timestamptz;
-- self-service deactivation: signing in within 30 days brings the account back
alter table users add column if not exists deactivated_at timestamptz;
alter table users add column if not exists language text not null default 'en';
alter table users add column if not exists email text;
alter table users add column if not exists email_settings jsonb not null default '{}';
create table if not exists data_exports (
	id bigint primary key,
	user_id bigint not null references users (id) on delete cascade,
	body jsonb not null,
	created_at timestamptz not null default now()
);
create unique index if not exists users_email_idx on users (lower(email));
alter table users add column if not exists status_restore text;
alter table posts add column if not exists hidden boolean not null default false;
alter table posts add column if not exists sensitive boolean not null default false;
alter table sessions add column if not exists id uuid not null default gen_random_uuid();
create unique index if not exists sessions_id_key on sessions(id);
alter table sessions add column if not exists last_seen_at timestamptz not null default now();
alter table sessions add column if not exists user_agent text;

create table if not exists staff_notes (
	id bigint primary key, user_id bigint not null references users(id) on delete cascade,
	actor_id bigint references users(id) on delete set null, body text not null check(char_length(body) between 1 and 2000),
	created_at timestamptz not null default now()
);
create index if not exists staff_notes_user_idx on staff_notes(user_id,id desc);
create index if not exists staff_notes_actor_idx on staff_notes(actor_id);
create table if not exists staff_messages (
	id bigint primary key, user_id bigint not null references users(id) on delete cascade,
	actor_id bigint references users(id) on delete set null,
	kind text not null check(kind in ('message','warning','strike')),
	body text not null check(char_length(body) between 1 and 2000),
	created_at timestamptz not null default now(), read_at timestamptz, revoked_at timestamptz
);
create index if not exists staff_messages_user_idx on staff_messages(user_id,id desc);
create index if not exists staff_messages_actor_idx on staff_messages(actor_id);
create table if not exists moderation_appeals (
	id bigint primary key, user_id bigint not null references users(id) on delete cascade,
	message_id bigint references staff_messages(id) on delete set null, body text not null,
	status text not null default 'open' check(status in ('open','accepted','rejected')),
	staff_reply text, reviewer_id bigint references users(id) on delete set null,
	created_at timestamptz not null default now(), resolved_at timestamptz
);
create index if not exists moderation_appeals_user_idx on moderation_appeals(user_id,id desc);
create index if not exists moderation_appeals_message_idx on moderation_appeals(message_id);
create index if not exists moderation_appeals_reviewer_idx on moderation_appeals(reviewer_id);
create unique index if not exists moderation_appeals_open_user_idx on moderation_appeals(user_id) where status='open';

alter table posts add column if not exists source text not null default 'Xitter for Web';
alter table users add column if not exists notes_writer boolean not null default false;
alter table users add column if not exists notes_alias text not null default ('Contributor-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12));
create unique index if not exists users_notes_alias_key on users(notes_alias);
create table if not exists client_platforms (
	id bigint primary key,
	label text not null check (char_length(label) between 1 and 80),
	token_hash text not null unique,
	creator_id bigint references users(id) on delete set null,
	revoked boolean not null default false,
	created_at timestamptz not null default now()
);
create index if not exists client_platforms_creator_idx on client_platforms(creator_id);

create table if not exists community_notes (
	id bigint primary key,
	post_id bigint not null references posts(id) on delete cascade,
	author_id bigint not null references users(id) on delete cascade,
	text text not null check (char_length(text) between 1 and 500),
	classification text not null check (classification in ('Misleading', 'NotMisleading')),
	created_at timestamptz not null default now(),
	unique(post_id, author_id)
);
create index if not exists community_notes_author_idx on community_notes(author_id);
alter table community_notes add column if not exists data_v1 jsonb not null default '{}';
create table if not exists community_note_ratings (
	note_id bigint not null references community_notes(id) on delete cascade,
	user_id bigint not null references users(id) on delete cascade,
	rating text not null check (rating in ('Helpful', 'SomewhatHelpful', 'NotHelpful')),
	primary key(note_id, user_id)
);
create index if not exists community_note_ratings_user_idx on community_note_ratings(user_id);
alter table community_note_ratings add column if not exists data_v2 jsonb not null default '{}';
create table if not exists community_note_requests (
	post_id bigint not null references posts(id) on delete cascade,
	user_id bigint not null references users(id) on delete cascade,
	created_at timestamptz not null default now(),
	primary key(post_id, user_id)
);
create index if not exists community_note_requests_user_idx on community_note_requests(user_id);
alter table community_note_requests add column if not exists source_link text;
alter table community_note_requests add column if not exists suggestion text;

create table if not exists likes (
	user_id bigint not null references users (id) on delete cascade,
	post_id bigint not null references posts (id) on delete cascade,
	created_at timestamptz not null default now(),
	primary key (user_id, post_id)
);
create index if not exists likes_post_idx on likes (post_id);

create table if not exists reposts (
	id bigint not null,
	user_id bigint not null references users (id) on delete cascade,
	post_id bigint not null references posts (id) on delete cascade,
	created_at timestamptz not null default now(),
	primary key (user_id, post_id)
);
create index if not exists reposts_post_idx on reposts (post_id);

create table if not exists bookmarks (
	user_id bigint not null references users (id) on delete cascade,
	post_id bigint not null references posts (id) on delete cascade,
	created_at timestamptz not null default now(),
	primary key (user_id, post_id)
);
create index if not exists bookmarks_post_idx on bookmarks (post_id);

create table if not exists follows (
	follower_id bigint not null references users (id) on delete cascade,
	followee_id bigint not null references users (id) on delete cascade,
	created_at timestamptz not null default now(),
	primary key (follower_id, followee_id),
	check (follower_id <> followee_id)
);
create index if not exists follows_followee_idx on follows (followee_id);

create table if not exists media (
	id bigint primary key,
	user_id bigint not null references users (id) on delete cascade,
	-- 'photo' or 'video'
	kind text not null,
	mime text not null,
	size integer not null,
	width integer not null,
	height integer not null,
	post_id bigint references posts (id) on delete set null,
	position smallint,
	created_at timestamptz not null default now()
);
create index if not exists media_post_idx on media (post_id, position);

alter table users add column if not exists website text not null default '';

alter table posts add column if not exists quote_id bigint references posts (id) on delete set null;
alter table users add column if not exists pinned_post_id bigint references posts (id) on delete set null;
create index if not exists reposts_user_idx on reposts (user_id, id desc);

-- posts and reposts as one ordered stream; a repost's own id places it in time
create or replace view feed_items as
	select p.id as item_id, p.id as post_id, null::bigint as reposter_id, p.user_id as author_id,
		p.reply_to_id is not null as is_reply, p.created_at
	from posts p
	union all
	select r.id, r.post_id, r.user_id, r.user_id, false, r.created_at
	from reposts r;

-- videos: converted after upload; 'processing' until ffmpeg is done
alter table media add column if not exists duration_ms integer;
alter table media add column if not exists state text not null default 'ready';

-- long-form articles; the body is the editor's Draft.js document, kept as sent.
-- Publishing creates a post that carries the article (posts.article_id).
create table if not exists articles (
	id bigint primary key,
	user_id bigint not null references users (id) on delete cascade,
	title text not null default '',
	content_state jsonb,
	plain_text text not null default '',
	cover_media_id bigint references media (id) on delete set null,
	-- 'Draft' or 'Published'
	state text not null default 'Draft',
	created_at timestamptz not null default now(),
	modified_at timestamptz not null default now(),
	first_published_at timestamptz
);
create index if not exists articles_user_idx on articles (user_id, state, modified_at desc);
alter table posts add column if not exists article_id bigint references articles (id) on delete set null;

-- accounts named with @ in a post; they get a notification and the name becomes a link
create table if not exists post_mentions (
	post_id bigint not null references posts (id) on delete cascade,
	user_id bigint not null references users (id) on delete cascade,
	primary key (post_id, user_id)
);
create index if not exists post_mentions_user_idx on post_mentions (user_id);
create index if not exists posts_quote_idx on posts (quote_id) where quote_id is not null;
create index if not exists posts_reply_idx on posts (reply_to_id) where reply_to_id is not null;
-- notifications newer than this are unread
alter table users add column if not exists notifications_seen_at timestamptz not null default now();

-- a block hides both accounts from each other; a mute only hides the muted
-- account from the muter's home feeds and notifications
create table if not exists blocks (
	blocker_id bigint not null references users (id) on delete cascade,
	blocked_id bigint not null references users (id) on delete cascade,
	created_at timestamptz not null default now(),
	primary key (blocker_id, blocked_id)
);
create index if not exists blocks_blocked_idx on blocks (blocked_id);
create table if not exists mutes (
	muter_id bigint not null references users (id) on delete cascade,
	muted_id bigint not null references users (id) on delete cascade,
	created_at timestamptz not null default now(),
	primary key (muter_id, muted_id)
);
-- muted words; surfaces are home_timeline, tweet_replies and notifications
create table if not exists muted_keywords (
	id bigint primary key,
	user_id bigint not null references users (id) on delete cascade,
	keyword text not null,
	surfaces text[] not null,
	exclude_following boolean not null default false,
	valid_until timestamptz,
	created_at timestamptz not null default now()
);
create unique index if not exists muted_keywords_user_word_idx on muted_keywords (user_id, lower(keyword));

-- sign-up is by invite; a code works until it runs out of uses or expires
create table if not exists invites (
	code text primary key,
	created_by bigint references users (id) on delete set null,
	max_uses integer not null default 1,
	uses integer not null default 0,
	expires_at timestamptz,
	created_at timestamptz not null default now()
);
alter table users add column if not exists invite_code text references invites (code) on delete set null;
-- a pride flag shown next to the name (see flags.ts), picked at sign-up
alter table users add column if not exists flag text;

-- Admin panel. Staff roles: admin (everything), moderator (users' standing and
-- posts), support (read, password resets, sign-outs). Every staff action is logged.
alter table users add column if not exists role text check (role in ('admin', 'moderator', 'support'));
-- active; restricted (can read, not post); limited (only followers see their
-- posts); suspended (can't sign in, hidden everywhere)
alter table users add column if not exists status text not null default 'active'
	check (status in ('active', 'restricted', 'limited', 'suspended'));
alter table users add column if not exists last_seen_at timestamptz;
create table if not exists audit_log (
	id bigint primary key,
	actor_id bigint references users (id) on delete set null,
	action text not null,
	target text,
	detail jsonb,
	created_at timestamptz not null default now()
);
create index if not exists audit_log_created_idx on audit_log (created_at desc);
-- organisations are business accounts; affiliates show the org's badge
create table if not exists affiliations (
	org_id bigint not null references users (id) on delete cascade,
	user_id bigint not null references users (id) on delete cascade,
	created_at timestamptz not null default now(),
	primary key (org_id, user_id)
);
create unique index if not exists affiliations_user_idx on affiliations (user_id);
-- instance-wide settings as key/value (sign-up mode, ...)
create table if not exists settings (
	key text primary key,
	value jsonb not null
);
alter table invites add column if not exists org_id bigint references users (id) on delete set null;
alter table invites add column if not exists revoked boolean not null default false;

-- reports from the client's Report post / Report account flow, for staff
create table if not exists reports (
	id bigint primary key,
	reporter_id bigint references users (id) on delete set null,
	-- what was reported: a post (and its author), or an account
	post_id bigint references posts (id) on delete set null,
	user_id bigint references users (id) on delete cascade,
	reason text not null,
	details text not null default '',
	-- open, dismissed or actioned
	status text not null default 'open',
	handled_by bigint references users (id) on delete set null,
	handled_at timestamptz,
	note text not null default '',
	created_at timestamptz not null default now()
);
create index if not exists reports_status_idx on reports (status, created_at desc);

-- for "About this account": when the badge was given, and past handles
alter table users add column if not exists verified_at timestamptz;
update users set verified_at = created_at where verified_type is not null and verified_at is null;
create table if not exists username_changes (
	user_id bigint not null references users (id) on delete cascade,
	old_name text not null,
	new_name text not null,
	changed_at timestamptz not null default now()
);
create index if not exists username_changes_user_idx on username_changes (user_id, changed_at desc);

-- sign-ups between the dialog's screens; kept here so a restart doesn't lose them
create table if not exists signup_sessions (
	token uuid primary key,
	username text not null,
	code text not null default '',
	created_at timestamptz not null default now()
);

-- Chat (src/chat.ts). Messages are encrypted by the browsers; what is kept is
-- each account's public keys, who is in which conversation, and every event as
-- the sealed blob the sender built, stamped by the server.
create table if not exists chat_keys (
	user_id bigint not null references users (id) on delete cascade,
	version bigint not null,
	public_key text not null,
	signing_public_key text not null,
	identity_public_key_signature text not null default '',
	registration_method text not null default 'CustomPin',
	created_at timestamptz not null default now(),
	primary key (user_id, version)
);
create table if not exists chat_members (
	conversation_id text not null,
	user_id bigint not null references users (id) on delete cascade,
	joined_at timestamptz not null default now(),
	primary key (conversation_id, user_id)
);
create index if not exists chat_members_user_idx on chat_members (user_id);
create table if not exists chat_events (
	seq bigint primary key,
	conversation_id text not null,
	sender_id bigint not null references users (id) on delete cascade,
	-- the event's detail: 1 message, 3 key change, 12 read, ... (chat.ts KIND)
	kind smallint not null,
	event bytea not null,
	created_at timestamptz not null default now()
);
create index if not exists chat_events_conversation_idx on chat_events (conversation_id, kind, seq desc);
create index if not exists chat_events_sender_idx on chat_events (sender_id);
alter table chat_members add column if not exists accepted boolean not null default true;
alter table chat_members add column if not exists archived boolean not null default false;
alter table chat_members add column if not exists muted boolean not null default false;
alter table chat_members add column if not exists deleted_before bigint not null default 0;
create table if not exists chat_conversations (
	id text primary key,
	creator_id bigint not null references users(id) on delete cascade,
	metadata jsonb not null default '{}',
	created boolean not null default false
);
create index if not exists chat_conversations_creator_idx on chat_conversations (creator_id);
create table if not exists chat_trust (
	user_id bigint not null references users(id) on delete cascade,
	trusted_id bigint not null references users(id) on delete cascade,
	primary key (user_id, trusted_id)
);
create index if not exists chat_trust_target_idx on chat_trust (trusted_id);
create table if not exists chat_hidden_events (
	user_id bigint not null references users(id) on delete cascade,
	seq bigint not null references chat_events(seq) on delete cascade,
	primary key (user_id, seq)
);
create index if not exists chat_hidden_events_seq_idx on chat_hidden_events (seq);
create table if not exists chat_uploads (
	hash text primary key,
	resume_id bigint not null unique,
	conversation_id text not null,
	message_id text not null,
	uploader_id bigint not null references users(id) on delete cascade,
	total_bytes bigint not null check (total_bytes > 0),
	ready boolean not null default false,
	expires_at timestamptz,
	created_at timestamptz not null default now()
);
create index if not exists chat_uploads_uploader_idx on chat_uploads (uploader_id);
alter table chat_events add column if not exists audience_id bigint references users(id) on delete cascade;
create index if not exists chat_events_audience_idx on chat_events (audience_id);
alter table chat_events add column if not exists deleted boolean not null default false;
alter table articles add column if not exists hidden boolean not null default false;
alter table users add column if not exists org_badge_id bigint references custom_badges(id) on delete set null;
create index if not exists users_org_badge_idx on users(org_badge_id);
create index if not exists users_status_until_idx on users(status_until) where status_until is not null;

create table if not exists lists (
	id bigint primary key,
	owner_id bigint not null references users (id) on delete cascade,
	name text not null,
	description text not null default '',
	is_private boolean not null default false,
	created_at timestamptz not null default now()
);
create index if not exists lists_owner_idx on lists (owner_id);

create table if not exists list_members (
	list_id bigint not null references lists (id) on delete cascade,
	user_id bigint not null references users (id) on delete cascade,
	created_at timestamptz not null default now(),
	primary key (list_id, user_id)
);
create index if not exists list_members_user_idx on list_members (user_id);

create table if not exists list_subscribers (
	list_id bigint not null references lists (id) on delete cascade,
	user_id bigint not null references users (id) on delete cascade,
	created_at timestamptz not null default now(),
	primary key (list_id, user_id)
);
create index if not exists list_subscribers_user_idx on list_subscribers (user_id);

-- a muted list's accounts stay out of the viewer's home feeds
create table if not exists list_mutes (
	list_id bigint not null references lists (id) on delete cascade,
	user_id bigint not null references users (id) on delete cascade,
	primary key (list_id, user_id)
);

-- lists shown as extra tabs on the viewer's home page
create table if not exists pinned_lists (
	user_id bigint not null references users (id) on delete cascade,
	list_id bigint not null references lists (id) on delete cascade,
	position int not null default 0,
	primary key (user_id, list_id)
);

create table if not exists communities (
	id bigint primary key,
	creator_id bigint not null references users (id) on delete cascade,
	name text not null,
	description text not null default '',
	question text not null default '',
	-- Open, RestrictedJoinRequestsRequireModeratorApproval, RestrictedJoinRequestsRequireAdminApproval, RestrictedJoinRequestsDisabled
	join_policy text not null default 'Open',
	-- MemberInvitesAllowed, ModeratorInvitesAllowed, AdminInvitesAllowed
	invites_policy text not null default 'MemberInvitesAllowed',
	is_nsfw boolean not null default false,
	banner_url text,
	created_at timestamptz not null default now()
);
create unique index if not exists communities_name_key on communities (lower(name));

create table if not exists community_members (
	community_id bigint not null references communities (id) on delete cascade,
	user_id bigint not null references users (id) on delete cascade,
	role text not null default 'Member' check (role in ('Member', 'Moderator', 'Admin')),
	created_at timestamptz not null default now(),
	primary key (community_id, user_id)
);
create index if not exists community_members_user_idx on community_members (user_id);

create table if not exists community_rules (
	id bigint primary key,
	community_id bigint not null references communities (id) on delete cascade,
	name text not null,
	description text not null default '',
	position int not null default 0
);
create index if not exists community_rules_community_idx on community_rules (community_id, position);

create table if not exists community_join_requests (
	community_id bigint not null references communities (id) on delete cascade,
	user_id bigint not null references users (id) on delete cascade,
	answer text not null default '',
	created_at timestamptz not null default now(),
	primary key (community_id, user_id)
);

alter table posts add column if not exists community_id bigint references communities (id) on delete set null;
create index if not exists posts_community_idx on posts (community_id, id desc) where community_id is not null;

create table if not exists polls (
	id bigint primary key,
	user_id bigint not null references users (id) on delete cascade,
	choices text[] not null,
	duration_minutes int not null,
	-- set when the post is created; the card exists before the post does
	ends_at timestamptz,
	created_at timestamptz not null default now()
);

create table if not exists poll_votes (
	poll_id bigint not null references polls (id) on delete cascade,
	user_id bigint not null references users (id) on delete cascade,
	choice smallint not null,
	created_at timestamptz not null default now(),
	primary key (poll_id, user_id)
);

alter table posts add column if not exists poll_id bigint references polls (id) on delete set null;

-- scheduled posts and drafts, kept as the composer sent them
create table if not exists scheduled_posts (
	id bigint primary key,
	user_id bigint not null references users (id) on delete cascade,
	kind text not null check (kind in ('scheduled', 'draft')),
	execute_at timestamptz,
	request jsonb not null,
	created_at timestamptz not null default now()
);
create index if not exists scheduled_posts_due_idx on scheduled_posts (execute_at) where kind = 'scheduled';
create index if not exists scheduled_posts_user_idx on scheduled_posts (user_id, kind);

alter table posts add column if not exists place_id text;

-- edits keep the post's id; what it said before each edit lives here under an
-- id of its own, so the client's edit history can fetch each version
alter table posts add column if not exists edit_count int not null default 0;
alter table posts add column if not exists edited_at timestamptz;
create table if not exists post_versions (
	version_id bigint primary key,
	post_id bigint not null references posts (id) on delete cascade,
	seq int not null,
	text text not null,
	-- when this version went up
	created_at timestamptz not null
);
create index if not exists post_versions_post_idx on post_versions (post_id, seq);

-- protected accounts: posts only for approved followers
alter table users add column if not exists protected boolean not null default false;
create table if not exists follow_requests (
	requester_id bigint not null references users (id) on delete cascade,
	target_id bigint not null references users (id) on delete cascade,
	created_at timestamptz not null default now(),
	primary key (requester_id, target_id),
	check (requester_id <> target_id)
);
create index if not exists follow_requests_target_idx on follow_requests (target_id, created_at desc);
