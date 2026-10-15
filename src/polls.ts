// Polls are cards: the composer creates the card first (caps /v2/cards/create),
// then posts with card_uri. Voting goes through the card passthrough endpoint.

import { sql } from "./db";
import { isId, newId } from "./ids";

const MAX_LABEL = 25;
const MIN_DURATION = 5;
const MAX_DURATION = 10080;

export class PollError extends Error {
	constructor(
		message: string,
		readonly status = 400,
	) {
		super(message);
	}
}

type PollRow = {
	id: string;
	choices: string[];
	duration_minutes: number;
	ends_at: Date | null;
	counts: number[];
	voted: number | null;
};

const text = (v: string) => ({ type: "STRING", string_value: v });

// binding values as the graphql card (array of { key, value }) and the
// passthrough response (object by key) both need them
function bindings(p: PollRow): Record<string, unknown> {
	const ended = !!p.ends_at && p.ends_at.getTime() <= Date.now();
	const out: Record<string, unknown> = {};
	p.choices.forEach((label, i) => {
		out[`choice${i + 1}_label`] = text(label);
		out[`choice${i + 1}_count`] = text(String(p.counts[i] ?? 0));
	});
	out.counts_are_final = { type: "BOOLEAN", boolean_value: ended };
	out.duration_minutes = text(String(p.duration_minutes));
	if (p.ends_at) out.end_datetime_utc = text(p.ends_at.toISOString());
	out.last_updated_datetime_utc = text(new Date().toISOString());
	out.api = text("capi://passthrough/1");
	out.card_url = text("https://twitter.com");
	if (p.voted) out.selected_choice = text(String(p.voted));
	return out;
}

const cardName = (n: number) => `poll${n}choice_text_only`;

export function pollCard(p: PollRow) {
	return {
		rest_id: `card://${p.id}`,
		legacy: {
			binding_values: Object.entries(bindings(p)).map(([key, value]) => ({ key, value })),
			card_platform: { platform: { audience: { name: "production" }, device: { name: "Swift", version: "12" } } },
			name: cardName(p.choices.length),
			url: `card://${p.id}`,
			user_refs_results: [],
		},
	};
}

export async function pollsByIds(viewerId: string, ids: string[]): Promise<Map<string, PollRow>> {
	if (!ids.length) return new Map();
	const rows = await sql`select p.id::text, p.choices, p.duration_minutes, p.ends_at,
			coalesce((select array_agg(c.n order by c.choice) from (
				select g.choice, count(v.user_id)::int as n from generate_series(1, array_length(p.choices, 1)) as g(choice)
				left join poll_votes v on v.poll_id = p.id and v.choice = g.choice group by g.choice) c), '{}') as counts,
			(select v.choice from poll_votes v where v.poll_id = p.id and v.user_id = ${viewerId}::bigint) as voted
		from polls p where p.id = any(${sql.array(ids, "INT8")})`;
	return new Map(rows.map((r: any) => [r.id as string, r as PollRow]));
}

export async function createCard(userId: string, raw: unknown): Promise<{ status: string; card_uri: string }> {
	let data: Record<string, unknown>;
	try {
		data = JSON.parse(String(raw));
	} catch {
		throw new PollError("card_data must be JSON.");
	}
	const kind = String(data["twitter:card"] ?? "");
	const n = /^poll([234])choice_text_only$/.exec(kind)?.[1];
	if (!n) throw new PollError("Only text polls are supported.");
	const choices: string[] = [];
	for (let i = 1; i <= Number(n); i++) {
		const label = String(data[`twitter:string:choice${i}_label`] ?? "").trim();
		if (!label) throw new PollError("Every choice needs a label.");
		if ([...label].length > MAX_LABEL) throw new PollError(`Choices can be up to ${MAX_LABEL} characters.`);
		choices.push(label);
	}
	const duration = Number(data["twitter:long:duration_minutes"] ?? 1440);
	if (!Number.isInteger(duration) || duration < MIN_DURATION || duration > MAX_DURATION) throw new PollError("A poll runs from 5 minutes to 7 days.");
	const id = newId();
	await sql`insert into polls (id, user_id, choices, duration_minutes) values (${id}::bigint, ${userId}::bigint, ${sql.array(choices, "TEXT")}, ${duration})`;
	return { status: "OK", card_uri: `card://${id}` };
}

// the post being created takes the card; its clock starts now
export async function attachPoll(userId: string, postId: string, cardUri: string): Promise<void> {
	const id = /^card:\/\/(\d{1,19})$/.exec(cardUri)?.[1];
	if (!id) throw new PollError("Unknown card.");
	const rows = await sql`update polls set ends_at = now() + make_interval(mins => duration_minutes)
		where id = ${id}::bigint and user_id = ${userId}::bigint and ends_at is null returning id`;
	if (!rows.length) throw new PollError("That poll can't be used.");
	await sql`update posts set poll_id = ${id}::bigint where id = ${postId}::bigint`;
}

export async function vote(viewerId: string, form: FormData): Promise<Record<string, unknown>> {
	const uri = String(form.get("twitter:string:card_uri") ?? "");
	const id = /^card:\/\/(\d{1,19})$/.exec(uri)?.[1];
	const choice = Number(form.get("twitter:string:selected_choice"));
	if (!id || !isId(id)) throw new PollError("Unknown card.", 404);
	const poll = (await pollsByIds(viewerId, [id])).get(id);
	if (!poll || !poll.ends_at) throw new PollError("Unknown card.", 404);
	if (!Number.isInteger(choice) || choice < 1 || choice > poll.choices.length) throw new PollError("Pick one of the choices.");
	if (poll.ends_at.getTime() <= Date.now()) throw new PollError("This poll has ended.");
	await sql`insert into poll_votes (poll_id, user_id, choice) values (${id}::bigint, ${viewerId}::bigint, ${choice}) on conflict do nothing`;
	const fresh = (await pollsByIds(viewerId, [id])).get(id)!;
	return {
		card: {
			name: cardName(fresh.choices.length),
			url: `card://${id}`,
			card_type_url: "http://card-dev.twitter.com/v2/card.json",
			binding_values: bindings(fresh),
			card_platform: { platform: { audience: { name: "production" }, device: { name: "Swift", version: "12" } } },
		},
	};
}
