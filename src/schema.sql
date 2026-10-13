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
