import type { User } from "./auth";
import { sql } from "./db";
import { newId } from "./ids";
import type { PostRow } from "./model";
import { articlesByIds } from "./articles";
import { mediaForPosts } from "./media";
import { toUser, userCols, usersByIds } from "./users";

export const MAX_POST_LENGTH = 280;
// @name, not preceded by a word character (so e-mail addresses do not count)
export const MENTION = /(?<![\w@])@(\w{1,15})/g;
const NO_LIMIT = "9223372036854775807";

// every post query starts from this; callers append where/order/limit
const select = (viewerId: string) => sql`
	select p.id, p.text, p.reply_to_id, p.conversation_id, p.quote_id, p.article_id, p.created_at,
		ru.id as reply_user_id, ru.screen_name as reply_screen_name,
		${userCols(viewerId)},
		(select count(*)::int from likes x where x.post_id = p.id) as like_count,
		(select count(*)::int from reposts x where x.post_id = p.id) as repost_count,
		(select count(*)::int from bookmarks x where x.post_id = p.id) as bookmark_count,
		(select count(*)::int from posts x where x.reply_to_id = p.id) as reply_count,
		(select count(*)::int from posts x where x.quote_id = p.id) as quote_count,
		exists (select 1 from likes x where x.post_id = p.id and x.user_id = ${viewerId}::bigint) as liked,
		exists (select 1 from reposts x where x.post_id = p.id and x.user_id = ${viewerId}::bigint) as reposted,
		exists (select 1 from bookmarks x where x.post_id = p.id and x.user_id = ${viewerId}::bigint) as bookmarked
	from posts p
	join users u on u.id = p.user_id
	left join posts rp on rp.id = p.reply_to_id
	left join users ru on ru.id = rp.user_id`;

function toRow(r: any): PostRow {
	return {
		id: r.id,
		text: r.text,
		reply_to_id: r.reply_to_id,
		conversation_id: r.conversation_id,
		quote_id: r.quote_id,
		article_id: r.article_id,
		created_at: r.created_at,
		reply_user_id: r.reply_user_id,
		reply_screen_name: r.reply_screen_name,
		like_count: r.like_count,
		repost_count: r.repost_count,
		bookmark_count: r.bookmark_count,
		reply_count: r.reply_count,
		quote_count: r.quote_count,
		liked: r.liked,
		reposted: r.reposted,
		bookmarked: r.bookmarked,
		author: toUser(r),
	};
}

// media, articles, and the post each one quotes (one level: a quote inside a quote is not expanded)
async function hydrate(viewerId: string, posts: PostRow[], quotes = true): Promise<PostRow[]> {
	const media = await mediaForPosts(posts.map((p) => p.id));
	for (const p of posts) p.media = media.get(p.id) ?? [];
	if (posts.length) {
		const mentions = await sql`select m.post_id, u.id, u.screen_name, u.name from post_mentions m join users u on u.id = m.user_id
			where m.post_id = any(${sql.array(posts.map((p) => p.id), "INT8")})`;
		for (const p of posts) p.mentions = mentions.filter((m: any) => String(m.post_id) === p.id).map((m: any) => ({ id: String(m.id), screen_name: m.screen_name, name: m.name }));
	}
	const articles = await articlesByIds(viewerId, [...new Set(posts.map((p) => p.article_id).filter((id): id is string => !!id))]);
	for (const p of posts) if (p.article_id) p.article = articles.get(p.article_id);
	const quoteIds = [...new Set(posts.map((p) => p.quote_id).filter((id): id is string => !!id))];
	if (quotes && quoteIds.length) {
		const quoted = await postsByIds(viewerId, quoteIds, false);
		for (const p of posts) if (p.quote_id) p.quoted = quoted.get(p.quote_id);
	}
	return posts;
}

export async function postsByIds(viewerId: string, ids: string[], quotes = true): Promise<Map<string, PostRow>> {
	if (!ids.length) return new Map();
	const rows = await sql`${select(viewerId)} where p.id = any(${sql.array(ids, "INT8")})`;
	const posts = await hydrate(viewerId, rows.map(toRow), quotes);
	return new Map(posts.map((p) => [p.id, p]));
}

export async function getPost(viewerId: string, id: string): Promise<PostRow | undefined> {
	return (await postsByIds(viewerId, [id])).get(id);
}

// One entry of a timeline: a post, or someone's repost of it. Reposts have
// their own id, which orders them among posts by when they were made.
export type FeedItem = { id: string; post: PostRow; repost?: { by: User; created_at: Date } };

export type FeedQuery = {
	viewerId: string;
	// whose posts and reposts: everyone, the viewer plus accounts they follow, or one account
	authors: { all: true } | { following: true } | { user: string };
	replies: boolean;
	kinds: "both" | "posts" | "reposts";
	// only posts with attached media of this kind
	media?: "any" | "photo" | "video";
	// replies and nothing else
	onlyReplies?: boolean;
	// posts that carry an article
	articlesOnly?: boolean;
	limit: number;
	// exclusive item ids
	before?: string;
	after?: string;
};

export async function feed(q: FeedQuery): Promise<FeedItem[]> {
	const authorFilter =
		"user" in q.authors
			? sql`f.author_id = ${q.authors.user}::bigint`
			: "following" in q.authors
				? sql`(f.author_id = ${q.viewerId}::bigint or f.author_id in (select followee_id from follows where follower_id = ${q.viewerId}::bigint))`
				: sql`true`;
	const kindFilter = q.kinds === "posts" ? sql`f.reposter_id is null` : q.kinds === "reposts" ? sql`f.reposter_id is not null` : sql`true`;
	const replyFilter = q.onlyReplies ? sql`f.is_reply` : q.replies ? sql`true` : sql`not f.is_reply`;
	const articleFilter = q.articlesOnly ? sql`exists (select 1 from posts a where a.id = f.post_id and a.article_id is not null)` : sql`true`;
	const mediaFilter = !q.media
		? sql`true`
		: q.media === "any"
			? sql`exists (select 1 from media m where m.post_id = f.post_id)`
			: q.media === "video"
				? sql`exists (select 1 from media m where m.post_id = f.post_id and m.kind = 'video')`
				: sql`exists (select 1 from media m where m.post_id = f.post_id and m.kind <> 'video')`;
	const rows = q.after
		? await sql`select * from feed_items f where ${authorFilter} and ${kindFilter} and ${replyFilter} and ${mediaFilter} and ${articleFilter} and f.item_id > ${q.after}::bigint
			order by f.item_id asc limit ${q.limit}`
		: await sql`select * from feed_items f where ${authorFilter} and ${kindFilter} and ${replyFilter} and ${mediaFilter} and ${articleFilter} and f.item_id < ${q.before ?? NO_LIMIT}::bigint
			order by f.item_id desc limit ${q.limit}`;
	if (q.after) rows.reverse();

	const posts = await postsByIds(q.viewerId, [...new Set(rows.map((r: any) => r.post_id as string))] as string[]);
	const reposters = await usersByIds(q.viewerId, [...new Set(rows.filter((r: any) => r.reposter_id).map((r: any) => r.reposter_id as string))] as string[]);
	const items: FeedItem[] = [];
	for (const r of rows) {
		const post = posts.get(r.post_id);
		if (!post) continue;
		const by = r.reposter_id ? reposters.get(r.reposter_id) : undefined;
		items.push({ id: r.item_id, post, ...(by ? { repost: { by, created_at: r.created_at } } : {}) });
	}
	return items;
}

// the chain of posts this one replies to, oldest first
export async function ancestors(viewerId: string, replyToId: string): Promise<PostRow[]> {
	const rows = await sql`${select(viewerId)}
		where p.id in (
			with recursive chain as (
				select id, reply_to_id from posts where id = ${replyToId}::bigint
				union all
				select x.id, x.reply_to_id from posts x join chain c on x.id = c.reply_to_id
			) select id from chain)
		order by p.id asc`;
	return hydrate(viewerId, rows.map(toRow));
}

export async function replies(viewerId: string, id: string, limit = 100): Promise<PostRow[]> {
	const rows = await sql`${select(viewerId)} where p.reply_to_id = ${id}::bigint order by p.id asc limit ${limit}`;
	return hydrate(viewerId, rows.map(toRow));
}

export async function bookmarkedPosts(viewerId: string, limit = 100): Promise<PostRow[]> {
	const rows = await sql`${select(viewerId)}
		join bookmarks b on b.post_id = p.id and b.user_id = ${viewerId}::bigint
		order by b.created_at desc limit ${limit}`;
	return hydrate(viewerId, rows.map(toRow));
}

export async function likedPosts(viewerId: string, userId: string, limit = 100): Promise<PostRow[]> {
	const rows = await sql`${select(viewerId)}
		join likes lk on lk.post_id = p.id and lk.user_id = ${userId}::bigint
		order by lk.created_at desc limit ${limit}`;
	return hydrate(viewerId, rows.map(toRow));
}

export async function createPost(userId: string, text: string, opts: { replyToId?: string; quoteId?: string; articleId?: string } = {}): Promise<string> {
	const id = newId();
	let conversationId = id;
	if (opts.replyToId) {
		const [parent] = await sql`select conversation_id from posts where id = ${opts.replyToId}::bigint`;
		if (!parent) throw new PostError("The post you are replying to no longer exists.", 385);
		conversationId = parent.conversation_id;
	}
	if (opts.quoteId) {
		const [quoted] = await sql`select id from posts where id = ${opts.quoteId}::bigint`;
		if (!quoted) throw new PostError("The post you are quoting no longer exists.", 385);
	}
	await sql`insert into posts (id, user_id, text, reply_to_id, conversation_id, quote_id, article_id)
		values (${id}::bigint, ${userId}::bigint, ${text}, ${opts.replyToId ?? null}::bigint, ${conversationId}::bigint, ${opts.quoteId ?? null}::bigint, ${opts.articleId ?? null}::bigint)`;
	const names = [...new Set([...text.matchAll(MENTION)].map((m) => m[1].toLowerCase()))].slice(0, 20);
	if (names.length)
		await sql`insert into post_mentions (post_id, user_id)
			select ${id}::bigint, u.id from users u where lower(u.screen_name) = any(${sql.array(names, "TEXT")}) on conflict do nothing`;
	return id;
}

export async function deletePost(userId: string, id: string): Promise<boolean> {
	const rows = await sql`delete from posts where id = ${id}::bigint and user_id = ${userId}::bigint returning id`;
	return rows.length > 0;
}

// only the author can pin, and only one post at a time
export async function setPinned(userId: string, postId: string | null): Promise<boolean> {
	if (postId === null) {
		await sql`update users set pinned_post_id = null where id = ${userId}::bigint`;
		return true;
	}
	const rows = await sql`update users set pinned_post_id = ${postId}::bigint
		where id = ${userId}::bigint and exists (select 1 from posts where id = ${postId}::bigint and user_id = ${userId}::bigint)
		returning id`;
	return rows.length > 0;
}

type Mark = "likes" | "bookmarks";

export async function setMark(table: Mark, userId: string, postId: string, on: boolean) {
	if (table === "likes") {
		if (on) await sql`insert into likes (user_id, post_id) values (${userId}::bigint, ${postId}::bigint) on conflict do nothing`;
		else await sql`delete from likes where user_id = ${userId}::bigint and post_id = ${postId}::bigint`;
	} else {
		if (on) await sql`insert into bookmarks (user_id, post_id) values (${userId}::bigint, ${postId}::bigint) on conflict do nothing`;
		else await sql`delete from bookmarks where user_id = ${userId}::bigint and post_id = ${postId}::bigint`;
	}
}

export async function repost(userId: string, postId: string): Promise<string> {
	const id = newId();
	const rows = await sql`insert into reposts (id, user_id, post_id) values (${id}::bigint, ${userId}::bigint, ${postId}::bigint)
		on conflict (user_id, post_id) do update set post_id = excluded.post_id returning id`;
	return rows[0].id;
}

export async function unrepost(userId: string, postId: string) {
	await sql`delete from reposts where user_id = ${userId}::bigint and post_id = ${postId}::bigint`;
}

export class PostError extends Error {
	constructor(
		message: string,
		public code: number,
	) {
		super(message);
	}
}
