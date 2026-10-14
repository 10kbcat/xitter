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
