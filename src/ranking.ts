// The "For you" feed: posts and reposts ranked by engagement, closeness and age,
// after the shape of X's published recommendation pipeline (gather candidates,
// score, filter and mix) with real counts in place of predicted ones.
//
// Weights relative to a like, from the 2023 release's heavy ranker: a repost is
// worth 2, a reply 27, and a reply the author answered 150. A post from someone
// the viewer follows, or that people they follow liked or reposted, gets a
// boost, as does an author the viewer often likes or replies to, or a post on a
// topic they follow. The total falls with age, so new posts can still rise past
// old popular ones.

import { sql } from "./db";
import { idTime } from "./ids";
import { type FeedItem, communityVisible, homeHidden, itemsFromRows } from "./posts";
import { followedTopicMatch, unwantedTopicMatch } from "./topics";

// how many candidates are ranked; the feed ends after them
const CANDIDATES = 600;
// at most this many entries in a row by one author
const MAX_RUN = 2;

export type RankedPage = { items: FeedItem[]; next?: number };

// One page of the ranked feed. `asOf` (an item id) pins the ranking for the pages of one
// scroll: posts newer than it wait for the next refresh, and ages are measured
// from it, so the order does not shift while the viewer pages down.
export async function rankedFeed(viewerId: string, opts: { asOf: string; offset: number; limit: number }): Promise<RankedPage> {
	// an item id: only entries up to it count, and ages are measured from its time
	const at = idTime(opts.asOf);
	const rows = await sql`
		with candidates as (
			select f.*, (select x.user_id from posts x where x.id = f.post_id) as original_author
			from feed_items f
			where not f.is_reply and f.item_id <= ${opts.asOf}::bigint and ${homeHidden(viewerId)} and ${communityVisible(viewerId)}
				and not ${unwantedTopicMatch(viewerId, sql`f.post_id`, sql`(select x.user_id from posts x where x.id = f.post_id)`)}
			order by f.item_id desc limit ${CANDIDATES * 3}
		),
		scored as (
			select c.*,
				(1
				 + (select count(*) from likes l where l.post_id = c.post_id)
				 + 2 * (select count(*) from reposts r where r.post_id = c.post_id)
				 + 27 * (select count(*) from posts rp where rp.reply_to_id = c.post_id)
				 + 150 * (select count(*) from posts rp where rp.reply_to_id = c.post_id
					and exists (select 1 from posts ar where ar.reply_to_id = rp.id and ar.user_id = c.original_author))
				)
				-- people the viewer follows: their posts and reposts, and what they liked or reposted
				* (case when c.author_id in (select followee_id from follows where follower_id = ${viewerId}::bigint) then 2.0 else 1.0 end)
				* (case when exists (select 1 from likes l join follows fw on fw.followee_id = l.user_id
						where l.post_id = c.post_id and fw.follower_id = ${viewerId}::bigint)
					or exists (select 1 from reposts r join follows fw on fw.followee_id = r.user_id
						where r.post_id = c.post_id and fw.follower_id = ${viewerId}::bigint) then 1.5 else 1.0 end)
				* (case when ${followedTopicMatch(viewerId, sql`c.post_id`)} then 1.5 else 1.0 end)
				-- authors the viewer engaged with in the last month, up to double
				* (1 + least(1.0, 0.1 * (
					(select count(*) from likes l join posts lp on lp.id = l.post_id
						where l.user_id = ${viewerId}::bigint and lp.user_id = c.original_author and l.created_at > ${at}::timestamptz - interval '30 days')
					+ (select count(*) from posts rp join posts parent on parent.id = rp.reply_to_id
						where rp.user_id = ${viewerId}::bigint and parent.user_id = c.original_author and rp.created_at > ${at}::timestamptz - interval '30 days'))))
				-- the viewer's own posts are known to them already
				* (case when c.original_author = ${viewerId}::bigint then 0.5 else 1.0 end)
				-- age in hours, gently: a day-old post needs about 10 times the engagement of a new one
				/ power(greatest(extract(epoch from (${at}::timestamptz - c.created_at)) / 3600, 0) + 2, 1.5)
				as score
			from candidates c
		),
		-- one entry per post: the best of the post itself and its reposts
		best as (
			select distinct on (post_id) * from scored order by post_id, score desc, item_id desc
		)
		select * from best order by score desc, item_id desc limit ${CANDIDATES}`;

	const ranked = spreadAuthors(rows as any[]);
	const pageRows = ranked.slice(opts.offset, opts.offset + opts.limit);
	const items = await itemsFromRows(viewerId, pageRows);
	const nextOffset = opts.offset + pageRows.length;
	return { items, ...(nextOffset < ranked.length ? { next: nextOffset } : {}) };
}

// Keep one author from filling the screen: an entry that would make a run
// longer than MAX_RUN waits until someone else has been shown.
function spreadAuthors<T extends { author_id: unknown }>(rows: T[]): T[] {
	const out: T[] = [];
	const waiting: T[] = [];
	const runOf = (author: string) => {
		let n = 0;
		for (let i = out.length - 1; i >= 0 && String(out[i].author_id) === author; i--) n++;
		return n;
	};
	for (const row of rows) {
		// a waiting entry goes first once it fits again
		for (let i = 0; i < waiting.length; i++) {
			if (runOf(String(waiting[i].author_id)) < MAX_RUN) out.push(...waiting.splice(i--, 1));
		}
		if (runOf(String(row.author_id)) < MAX_RUN) out.push(row);
		else waiting.push(row);
	}
	// nobody else left to put in between
	return out.concat(waiting);
}
