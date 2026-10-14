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
