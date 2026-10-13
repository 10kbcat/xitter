import type { User } from "./auth";
import { sql } from "./db";

// Author columns shared by every query that returns a user; expects the users
// table aliased as `u`. Counters and the viewer's relation come along so the
// same account never reaches the client in two different states.
export const userCols = (viewerId: string) => sql`
	u.id as a_id, u.screen_name as a_screen_name, u.name as a_name, u.bio as a_bio, u.location as a_location,
	u.avatar_url as a_avatar_url, u.banner_url as a_banner_url, u.verified_type as a_verified_type, u.created_at as a_created_at,
	(select count(*)::int from posts x where x.user_id = u.id) as a_posts,
	(select count(*)::int from likes x where x.user_id = u.id) as a_likes,
	(select count(*)::int from follows x where x.followee_id = u.id) as a_followers,
	(select count(*)::int from follows x where x.follower_id = u.id) as a_following,
	exists (select 1 from follows x where x.follower_id = ${viewerId}::bigint and x.followee_id = u.id) as a_followed_by_viewer,
	exists (select 1 from follows x where x.follower_id = u.id and x.followee_id = ${viewerId}::bigint) as a_follows_viewer`;

export function toUser(r: any): User {
	return {
		id: r.a_id,
		screen_name: r.a_screen_name,
		name: r.a_name,
		bio: r.a_bio,
		location: r.a_location,
		avatar_url: r.a_avatar_url,
		banner_url: r.a_banner_url,
		verified_type: r.a_verified_type,
		created_at: r.a_created_at,
		stats: {
			posts: r.a_posts,
			likes: r.a_likes,
			followers: r.a_followers,
			following: r.a_following,
			followedByViewer: r.a_followed_by_viewer,
			followsViewer: r.a_follows_viewer,
		},
	};
}

export async function userByName(viewerId: string, screenName: string): Promise<User | undefined> {
	const rows = await sql`select ${userCols(viewerId)} from users u where lower(u.screen_name) = lower(${screenName})`;
	return rows[0] && toUser(rows[0]);
}

export async function userById(viewerId: string, id: string): Promise<User | undefined> {
	const rows = await sql`select ${userCols(viewerId)} from users u where u.id = ${id}::bigint`;
	return rows[0] && toUser(rows[0]);
}

export async function setFollow(followerId: string, followeeId: string, on: boolean) {
	if (followerId === followeeId) return;
	if (on) await sql`insert into follows (follower_id, followee_id) values (${followerId}::bigint, ${followeeId}::bigint) on conflict do nothing`;
	else await sql`delete from follows where follower_id = ${followerId}::bigint and followee_id = ${followeeId}::bigint`;
}

// accounts `userId` follows, or accounts following `userId`
export async function followList(viewerId: string, userId: string, kind: "following" | "followers", limit = 200): Promise<User[]> {
	const rows =
		kind === "following"
			? await sql`select ${userCols(viewerId)} from follows f join users u on u.id = f.followee_id
				where f.follower_id = ${userId}::bigint order by f.created_at desc limit ${limit}`
			: await sql`select ${userCols(viewerId)} from follows f join users u on u.id = f.follower_id
				where f.followee_id = ${userId}::bigint order by f.created_at desc limit ${limit}`;
	return rows.map(toUser);
}
