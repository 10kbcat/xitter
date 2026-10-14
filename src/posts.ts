import { sql } from "./db";
import { newId } from "./ids";
import type { PostRow } from "./model";
import { mediaForPosts } from "./media";
import { toUser, userCols } from "./users";

export const MAX_POST_LENGTH = 280;

// every post query starts from this; callers append where/order/limit
const select = (viewerId: string) => sql`
	select p.id, p.text, p.reply_to_id, p.conversation_id, p.created_at,
		ru.id as reply_user_id, ru.screen_name as reply_screen_name,
		${userCols(viewerId)},
		(select count(*)::int from likes x where x.post_id = p.id) as like_count,
		(select count(*)::int from reposts x where x.post_id = p.id) as repost_count,
		(select count(*)::int from bookmarks x where x.post_id = p.id) as bookmark_count,
		(select count(*)::int from posts x where x.reply_to_id = p.id) as reply_count,
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
		created_at: r.created_at,
		reply_user_id: r.reply_user_id,
		reply_screen_name: r.reply_screen_name,
		like_count: r.like_count,
		repost_count: r.repost_count,
		bookmark_count: r.bookmark_count,
		reply_count: r.reply_count,
		liked: r.liked,
		reposted: r.reposted,
		bookmarked: r.bookmarked,
		author: toUser(r),
	};
}

async function withMedia(posts: PostRow[]): Promise<PostRow[]> {
	const media = await mediaForPosts(posts.map((p) => p.id));
	for (const p of posts) p.media = media.get(p.id) ?? [];
	return posts;
}

export async function getPost(viewerId: string, id: string): Promise<PostRow | undefined> {
	const rows = await sql`${select(viewerId)} where p.id = ${id}::bigint`;
	return rows[0] && (await withMedia([toRow(rows[0])]))[0];
}

// top-level posts, newest first; `before`/`after` are exclusive post ids
export async function homePosts(viewerId: string, limit: number, range: { before?: string; after?: string }): Promise<PostRow[]> {
	const rows = range.after
		? await sql`${select(viewerId)} where p.reply_to_id is null and p.id > ${range.after}::bigint order by p.id desc limit ${limit}`
		: range.before
			? await sql`${select(viewerId)} where p.reply_to_id is null and p.id < ${range.before}::bigint order by p.id desc limit ${limit}`
			: await sql`${select(viewerId)} where p.reply_to_id is null order by p.id desc limit ${limit}`;
	return withMedia(rows.map(toRow));
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
	return withMedia(rows.map(toRow));
}

export async function replies(viewerId: string, id: string, limit = 100): Promise<PostRow[]> {
	const rows = await sql`${select(viewerId)} where p.reply_to_id = ${id}::bigint order by p.id asc limit ${limit}`;
	return withMedia(rows.map(toRow));
}

export async function bookmarkedPosts(viewerId: string, limit = 100): Promise<PostRow[]> {
	const rows = await sql`${select(viewerId)}
		join bookmarks b on b.post_id = p.id and b.user_id = ${viewerId}::bigint
		order by b.created_at desc limit ${limit}`;
	return withMedia(rows.map(toRow));
}

// posts on a profile, newest first; replies only on the "with replies" tab
export async function userPosts(viewerId: string, userId: string, withReplies: boolean, limit: number, before?: string): Promise<PostRow[]> {
	const max = before ?? "9223372036854775807";
	const rows = withReplies
		? await sql`${select(viewerId)} where p.user_id = ${userId}::bigint and p.id < ${max}::bigint order by p.id desc limit ${limit}`
		: await sql`${select(viewerId)} where p.user_id = ${userId}::bigint and p.reply_to_id is null and p.id < ${max}::bigint order by p.id desc limit ${limit}`;
	return withMedia(rows.map(toRow));
}

export async function likedPosts(viewerId: string, userId: string, limit = 100): Promise<PostRow[]> {
	const rows = await sql`${select(viewerId)}
		join likes lk on lk.post_id = p.id and lk.user_id = ${userId}::bigint
		order by lk.created_at desc limit ${limit}`;
	return withMedia(rows.map(toRow));
}

export async function createPost(userId: string, text: string, replyToId?: string): Promise<string> {
	const id = newId();
	let conversationId = id;
	if (replyToId) {
		const [parent] = await sql`select conversation_id from posts where id = ${replyToId}::bigint`;
		if (!parent) throw new PostError("The post you are replying to no longer exists.", 385);
		conversationId = parent.conversation_id;
	}
	await sql`insert into posts (id, user_id, text, reply_to_id, conversation_id)
		values (${id}::bigint, ${userId}::bigint, ${text}, ${replyToId ?? null}::bigint, ${conversationId}::bigint)`;
	return id;
}

export async function deletePost(userId: string, id: string): Promise<boolean> {
	const rows = await sql`delete from posts where id = ${id}::bigint and user_id = ${userId}::bigint returning id`;
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
