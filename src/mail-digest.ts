// Notification mail, for accounts that turned it on in Settings > Notifications
// > Email notifications: "Activity related to you and your posts"
// (send_network_activity_email) and "New messages" (send_new_direct_text_email).
// Both are digests: one mail says how many unread things are waiting, sent only
// while the account has been away a while and at most every few hours, so a busy
// day is one mail, not hundreds. Messages are end-to-end encrypted; the mail
// says who wrote, never what.

import { PUBLIC_ORIGIN } from "./config";
import { sql } from "./db";
import { mailEnabled, sendMail } from "./mail";
import { unreadCount } from "./notifications";
import { settings } from "./settings";

// away this long before anything is mailed
export const AWAY_MINUTES = 30;
// and no more often than this
export const EVERY_HOURS = 4;

const people = (names: string[]) => (names.length <= 2 ? names.join(" and ") : `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`);

// accounts due a digest of `setting`, by `column` (when it last went out)
const due = (setting: string, column: "activity_mailed_at" | "messages_mailed_at") =>
	sql`select u.id::text, u.screen_name, u.email, u.notifications_seen_at, u.${sql(column)} as mailed_at from users u
		where u.email is not null and u.status = 'active' and (u.email_settings->>${setting})::boolean is true
			and (u.last_seen_at is null or u.last_seen_at < now() - make_interval(mins => ${AWAY_MINUTES}))
			and (u.${sql(column)} is null or u.${sql(column)} < now() - make_interval(hours => ${EVERY_HOURS}))`;

// Without a Resend key each mail is only logged as skipped (Admin > Settings > Email).
export async function mailDigests(): Promise<number> {
	const name = settings().instance_name;
	let sent = 0;

	for (const u of await due("send_network_activity_email", "activity_mailed_at")) {
		// only what arrived since the last mail, and still unread
		const since = Math.max(new Date(u.notifications_seen_at).getTime(), u.mailed_at ? new Date(u.mailed_at).getTime() : 0);
		const n = await unreadCount(u.id, since);
		if (!n) continue;
		await sql`update users set activity_mailed_at = now() where id = ${u.id}::bigint`;
		await sendMail(
			u.email,
			`You have ${n} new notification${n === 1 ? "" : "s"} on ${name}`,
			`Hi @${u.screen_name},\n\nWhile you were away there ${n === 1 ? "was 1 new notification" : `were ${n} new notifications`} for you on ${name}.\n\nSee them: ${PUBLIC_ORIGIN}/notifications\n\nYou get this because "Activity related to you" is on in Settings > Notifications > Email notifications.`,
			{ kind: "activity_digest", userId: u.id },
		).then(() => sent++, (e) => console.error("activity digest:", e.message));
	}

	for (const u of await due("send_new_direct_text_email", "messages_mailed_at")) {
		const since = u.mailed_at ? new Date(u.mailed_at) : new Date(Date.now() - EVERY_HOURS * 3600_000);
		const senders = await sql`select distinct s.screen_name from chat_events e
			join chat_members m on m.conversation_id = e.conversation_id and m.user_id = ${u.id}::bigint and m.accepted and not m.muted
			join users s on s.id = e.sender_id
			where e.kind = 1 and e.sender_id <> ${u.id}::bigint and e.created_at > ${since}
				and e.created_at > coalesce(${u.mailed_at ?? null}::timestamptz, 'epoch')
				and not exists (select 1 from blocks b where b.blocker_id = ${u.id}::bigint and b.blocked_id = e.sender_id)`;
		if (!senders.length) continue;
		await sql`update users set messages_mailed_at = now() where id = ${u.id}::bigint`;
		const from = people(senders.map((s: any) => `@${s.screen_name}`));
		await sendMail(
			u.email,
			`New message${senders.length === 1 ? "" : "s"} from ${from} on ${name}`,
			`Hi @${u.screen_name},\n\n${from} sent you ${senders.length === 1 ? "a message" : "messages"} on ${name}. Messages are end-to-end encrypted, so this mail can't show them.\n\nRead them: ${PUBLIC_ORIGIN}/i/chat\n\nYou get this because "New messages" is on in Settings > Notifications > Email notifications.`,
			{ kind: "message_digest", userId: u.id },
		).then(() => sent++, (e) => console.error("message digest:", e.message));
	}
	return sent;
}

export function startMailDigests() {
	setInterval(() => {
		if (mailEnabled()) void mailDigests().catch((e) => console.error("mail digests:", e));
	}, 5 * 60_000).unref();
}
