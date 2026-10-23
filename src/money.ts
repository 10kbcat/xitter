// X Money at /account/money, opened from the side bar (tidy.ts): every account
// has a wallet and sends money to other accounts on this instance. It is the
// instance's own play money: a new wallet starts with the instance's starting balance (settings.ts money),
// and admins add more here. Nothing is paid in or out.

import { accountPage, esc } from "./account-page";
import { audit } from "./admin";
import type { Viewer } from "./auth";
import { isBlockedEitherWay } from "./blocks";
import { sql } from "./db";
import { hateIn } from "./hate";
import { PUBLIC_ORIGIN } from "./config";
import { linksIn } from "./links";
import { absolute } from "./media";
import { avatarUrl } from "./model";
import { newId } from "./ids";
import { hit } from "./ratelimit";
import { feature, hasBlockedPhrase, settings } from "./settings";
import { MONEY_ICON } from "./tidy";
import { CARD_CSS } from "./money-ui";

export const NOTE_MAX = 140;

export class MoneyError extends Error {}

// "$12.50", "12.5" or "12" in cents; null when it isn't an amount
export function parseAmount(text: string): number | null {
	const m = /^\$?\s*(\d{1,9})(?:\.(\d{1,2}))?$/.exec(text.trim().replace(/,/g, ""));
	if (!m) return null;
	return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
}

export const formatCents = (cents: number | bigint) => {
	const n = Number(cents);
	const dollars = Math.floor(n / 100).toLocaleString("en-US");
	return `$${dollars}.${String(n % 100).padStart(2, "0")}`;
};
// whole amounts without their cents, as X shows them ("$100", "$3.52")
const shortCents = (cents: number) => (cents % 100 ? formatCents(cents) : `$${(cents / 100).toLocaleString("en-US")}`);

// the wallet's row, made with the starting balance the first time
async function ensureWallet(userId: string, db: typeof sql = sql) {
	await db`insert into money_wallets (user_id, balance_cents) values (${userId}::bigint, ${settings().money.starting_cents})
		on conflict (user_id) do nothing`;
}

export async function balanceOf(userId: string): Promise<number> {
	await ensureWallet(userId);
	const [w] = await sql`select balance_cents from money_wallets where user_id = ${userId}::bigint`;
	return Number(w.balance_cents);
}

// local, usable accounts only: money stays on this instance
async function recipientFor(handle: string) {
	const name = handle.trim().replace(/^@/, "");
	if (!/^[A-Za-z0-9_]{1,15}$/.test(name)) return null;
	const [u] = await sql`select id, screen_name, name from users
		where lower(screen_name) = lower(${name}) and instance is null and status <> 'suspended' and deactivated_at is null`;
	return u ?? null;
}

// Moves the money in one transaction. Both wallets are locked in id order, so
// two people paying each other at once can't deadlock. A repeated `idem`
// returns the transfer it already made.
export async function sendMoney(senderId: string, handle: string, amountCents: number, note: string, idem: string): Promise<{ id: string; to: string; repeated: boolean }> {
	if (!Number.isSafeInteger(amountCents) || amountCents <= 0) throw new MoneyError("Enter an amount over $0.");
	const max = settings().money.max_transfer_cents;
	if (amountCents > max) throw new MoneyError(`You can send up to ${formatCents(max)} at a time.`);
	note = note.trim();
	if ([...note].length > NOTE_MAX) throw new MoneyError(`Notes are up to ${NOTE_MAX} characters.`);
	if (note && (hateIn(note) || hasBlockedPhrase(note))) throw new MoneyError("That note can't be sent.");
	if (!/^[\w-]{8,64}$/.test(idem)) throw new MoneyError("The form expired. Try again.");
	const to = await recipientFor(handle);
	if (!to) throw new MoneyError("There's no account here with that username.");
	if (String(to.id) === senderId) throw new MoneyError("You can't send money to yourself.");
	if (await isBlockedEitherWay(senderId, String(to.id))) throw new MoneyError(`You can't send money to @${to.screen_name}.`);
	return sql.begin(async (tx) => {
		const [done] = await tx`select id from money_transfers where sender_id = ${senderId}::bigint and idem = ${idem}`;
		if (done) return { id: String(done.id), to: to.screen_name, repeated: true };
		await ensureWallet(senderId, tx);
		await ensureWallet(String(to.id), tx);
		const wallets = await tx`select user_id, balance_cents from money_wallets
			where user_id in (${senderId}::bigint, ${to.id}::bigint) order by user_id for update`;
		const mine = wallets.find((w: any) => String(w.user_id) === senderId);
		if (Number(mine.balance_cents) < amountCents) throw new MoneyError("You don't have enough money for that.");
		const id = newId();
		await tx`update money_wallets set balance_cents = balance_cents - ${amountCents} where user_id = ${senderId}::bigint`;
		await tx`update money_wallets set balance_cents = balance_cents + ${amountCents} where user_id = ${to.id}::bigint`;
		await tx`insert into money_transfers (id, sender_id, recipient_id, amount_cents, note, idem)
			values (${id}::bigint, ${senderId}::bigint, ${to.id}::bigint, ${amountCents}, ${note}, ${idem})`;
		return { id, to: to.screen_name, repeated: false };
	});
}

// staff adding to an account's balance (or taking from it, never below zero)
async function adjust(viewer: Viewer, handle: string, cents: number) {
	const to = await recipientFor(handle);
	if (!to) throw new MoneyError("There's no account here with that username.");
	await ensureWallet(String(to.id));
	const [w] = await sql`update money_wallets set balance_cents = greatest(balance_cents + ${cents}, 0)
		where user_id = ${to.id}::bigint returning balance_cents`;
	await audit(viewer, "money_adjust", String(to.id), { cents, balance: Number(w.balance_cents) });
	return { to: to.screen_name, balance: Number(w.balance_cents) };
}

// A payment's address. Put in a post by either side, it shows there as a
// payment card (paymentCards below, money-ui.ts in the client).
export const paymentUrl = (id: string) => `${PUBLIC_ORIGIN}/i/xmoney/p/${id}`;
const OWN_HOST = new URL(PUBLIC_ORIGIN).host;
const PAYMENT_PATH = /^\/i\/xmoney\/p\/(\d{1,19})\/?$/;
export function paymentIdOf(url: string): string | undefined {
	try {
		const u = new URL(url);
		return u.host === OWN_HOST ? PAYMENT_PATH.exec(u.pathname)?.[1] : undefined;
	} catch {
		return undefined;
	}
}

type Party = { id: string; screen_name: string; name: string; avatar: string; banner: string | null; badge: string | null };
export type Payment = { id: string; amount: number; note: string; at: Date; sender: Party; recipient: Party };

const party = (r: any, p: "s" | "r"): Party => ({
	id: String(r[`${p}_id`]),
	screen_name: r[`${p}_screen_name`],
	name: r[`${p}_name`] || r[`${p}_screen_name`],
	avatar: avatarUrl(r[`${p}_avatar`]),
	banner: r[`${p}_banner`] ? absolute(r[`${p}_banner`]) : null,
	badge: r[`${p}_badge`] ?? null,
});

// payments by id, with both sides; `visibleTo` keeps the ones that account is
// part of or that one side put in a post
async function payments(ids: string[], visibleTo?: string): Promise<Map<string, Payment>> {
	if (!ids.length) return new Map();
	const rows = await sql`select t.id, t.amount_cents, t.note, t.created_at,
			s.id as s_id, s.screen_name as s_screen_name, s.name as s_name, s.avatar_url as s_avatar, s.banner_url as s_banner, s.verified_type as s_badge,
			r.id as r_id, r.screen_name as r_screen_name, r.name as r_name, r.avatar_url as r_avatar, r.banner_url as r_banner, r.verified_type as r_badge
		from money_transfers t join users s on s.id = t.sender_id join users r on r.id = t.recipient_id
		where t.id = any(${sql.array(ids, "INT8")})
		${
			visibleTo
				? sql`and (${visibleTo}::bigint in (t.sender_id, t.recipient_id) or exists (select 1 from posts p
				where p.user_id in (t.sender_id, t.recipient_id) and p.text ~ ('/i/xmoney/p/' || t.id::text || '([^0-9]|$)')))`
				: sql``
		}`;
	return new Map(rows.map((r: any) => [String(r.id), { id: String(r.id), amount: Number(r.amount_cents), note: r.note, at: new Date(r.created_at), sender: party(r, "s"), recipient: party(r, "r") }]));
}

// Posts carrying one of their own payments' links get its card. The card is
// X's plain summary card, which the client script draws over as X Money's.
export async function paymentCards(posts: { authorId: string; text: string }[]): Promise<(Record<string, unknown> | undefined)[]> {
	const wanted = posts.map((p, index) => ({ ...p, index, id: linksIn(p.text).map((l) => paymentIdOf(l.url)).find((id) => !!id) })).filter((p) => p.id);
	const found = await payments([...new Set(wanted.map((p) => p.id!))]);
	const out: (Record<string, unknown> | undefined)[] = posts.map(() => undefined);
	for (const p of wanted) {
		const t = found.get(p.id!);
		if (!t || (p.authorId !== t.sender.id && p.authorId !== t.recipient.id)) continue;
		const str = (v: string) => ({ string_value: v, type: "STRING" });
		const merchant = t.recipient.badge === "business";
		const title = merchant ? `${shortCents(t.amount)} at ${t.recipient.name}` : p.authorId === t.sender.id ? `${shortCents(t.amount)} sent to ${t.recipient.name}` : `${shortCents(t.amount)} from ${t.sender.name}`;
		const face = p.authorId === t.sender.id ? t.recipient.avatar : t.sender.avatar;
		const image = { image_value: { url: face, width: 400, height: 400, alt: null }, type: "IMAGE" };
		const url = paymentUrl(t.id);
		const values: Record<string, unknown> = {
			title: str(title),
			description: str(t.note ? `“${t.note}”` : `${settings().instance_name} Money · ${date(t.at)}`),
			domain: str(OWN_HOST),
			vanity_url: { ...str(OWN_HOST), scribe_key: "vanity_url" },
			card_url: { ...str(url), scribe_key: "card_url" },
			thumbnail_image: image,
			thumbnail_image_large: image,
			thumbnail_image_original: image,
		};
		out[p.index] = {
			rest_id: url,
			legacy: {
				binding_values: Object.entries(values).map(([key, value]) => ({ key, value })),
				card_platform: { platform: { audience: { name: "production" }, device: { name: "Swift", version: "12" } } },
				name: "summary",
				url,
				user_refs_results: [],
			},
		};
	}
	return out;
}

// X's verified badge, in the account's colour
const BADGE_PATH = "M22.25 12c0-1.43-.88-2.67-2.19-3.34.46-1.39.2-2.9-.81-3.91s-2.52-1.27-3.91-.81c-.66-1.31-1.91-2.19-3.34-2.19s-2.67.88-3.33 2.19c-1.4-.46-2.91-.2-3.92.81s-1.26 2.52-.8 3.91c-1.31.67-2.2 1.91-2.2 3.34s.89 2.67 2.2 3.34c-.46 1.39-.21 2.9.8 3.91s2.52 1.26 3.91.81c.67 1.31 1.91 2.19 3.34 2.19s2.68-.88 3.34-2.19c1.39.45 2.9.2 3.91-.81s1.27-2.52.81-3.91c1.31-.67 2.19-1.91 2.19-3.34zm-11.71 4.2L6.8 12.46l1.41-1.42 2.26 2.26 4.8-5.23 1.47 1.36-6.2 6.77z";
const BADGE_COLOR: Record<string, string> = { blue: "#1d9bf0", business: "#e2b719", government: "#829aab", government_individual: "#829aab" };
const badge = (type: string | null) => (type && BADGE_COLOR[type] ? `<svg class="xm-badge" viewBox="0 0 22 22" aria-label="Verified account" role="img"><path fill="${BADGE_COLOR[type]}" d="${BADGE_PATH}"/></svg>` : "");

const date = (d: Date) => new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", ...(new Date(d).getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}) });

// The card as X draws a payment in a post: a person paid shows the amount, both
// faces and the note; a business (gold badge) is a purchase, with its banner
// and logo when it has a banner. `by` is the account the card speaks for.
export function cardHtml(t: Payment, by: string) {
	const href = `/i/xmoney/p/${t.id}`;
	const r = t.recipient;
	if (r.badge === "business") {
		if (r.banner)
			return `<a class="xm-card xm-shop" href="${href}" data-xmoney="${t.id}"><div class="xm-banner" style="background-image:url(&quot;${esc(r.banner)}&quot;)"></div>
<div class="xm-body"><img class="xm-logo" src="${esc(r.avatar)}" alt=""><div class="xm-row"><span class="xm-who"><b>${esc(r.name)}</b>${badge(r.badge)}</span><span class="xm-dim">${date(t.at)}</span></div>
<div class="xm-rule"></div><div class="xm-amt">${shortCents(t.amount)}</div><div class="xm-dim">with ${MONEY_WORDMARK}</div></div></a>`;
		return `<a class="xm-card xm-buy" href="${href}" data-xmoney="${t.id}"><img class="xm-logo" src="${esc(r.avatar)}" alt="">
<div class="xm-grow"><div class="xm-line"><b>${shortCents(t.amount)}</b> <span class="xm-dim">at</span> <b>${esc(r.name)}</b>${badge(r.badge)}</div><div class="xm-dim">with ${MONEY_WORDMARK}</div></div><span class="xm-dim xm-end">${date(t.at)}</span></a>`;
	}
	const sent = by !== r.screen_name.toLowerCase();
	const other = sent ? r : t.sender;
	return `<a class="xm-card xm-p2p" href="${href}" data-xmoney="${t.id}"><div class="xm-row"><div class="xm-amt">${shortCents(t.amount)}</div>
<div class="xm-faces"><img src="${esc(t.sender.avatar)}" alt=""><img src="${esc(r.avatar)}" alt=""></div></div>
<div class="xm-line"><span class="xm-dim">${sent ? "sent to" : "from"}</span> <b>${esc(other.name)}</b>${badge(other.badge)}</div>
<div class="xm-row">${t.note ? `<span class="xm-dim xm-note">"${esc(t.note)}"</span>` : "<span></span>"}<span class="xm-dim">${date(t.at)}</span></div></a>`;
}
// "with [$] Money", where X writes "with my X Card"
const MONEY_WORDMARK = `<span class="xm-mark"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${MONEY_ICON}"/></svg>Money</span>`;


// GET /i/api/xitter/money/cards?ids=1,2&by=<handle>: the cards the viewer may see, as HTML
export async function cardsApi(viewer: Viewer, url: URL): Promise<Response> {
	const ids = (url.searchParams.get("ids") ?? "").split(",").filter((id) => /^\d{1,19}$/.test(id)).slice(0, 40);
	const by = (url.searchParams.get("by") ?? "").toLowerCase();
	const found = await payments(ids, viewer.id);
	return Response.json(Object.fromEntries([...found].map(([id, t]) => [id, cardHtml(t, by)])), { headers: { "cache-control": "private, max-age=60" } });
}

// GET /i/api/xitter/money/recent: the viewer's latest payments for the composer's picker
export async function recentApi(viewer: Viewer): Promise<Response> {
	if (!feature("money")) return Response.json([]);
	const rows = await sql`select id from money_transfers where sender_id = ${viewer.id}::bigint or recipient_id = ${viewer.id}::bigint order by id desc limit 12`;
	const found = await payments(rows.map((r: any) => String(r.id)));
	return Response.json(
		rows.map((r: any) => found.get(String(r.id))).filter((t: Payment | undefined): t is Payment => !!t).map((t: Payment) => {
			const sent = t.sender.id === viewer.id;
			const other = sent ? t.recipient : t.sender;
			return { id: t.id, url: paymentUrl(t.id), amount: shortCents(t.amount), sent, shop: sent && other.badge === "business", name: other.name, avatar: other.avatar, note: t.note, date: date(t.at) };
		}),
	);
}

async function activity(userId: string) {
	return sql`select t.id, t.amount_cents, t.note, t.created_at, t.sender_id = ${userId}::bigint as sent,
			o.screen_name, o.name, o.avatar_url, o.verified_type
		from money_transfers t
		join users o on o.id = case when t.sender_id = ${userId}::bigint then t.recipient_id else t.sender_id end
		where t.sender_id = ${userId}::bigint or t.recipient_id = ${userId}::bigint
		order by t.id desc limit 50`;
}

// people to pay in one tap: the latest the viewer paid or was paid by, then accounts they follow
async function quickPicks(userId: string) {
	return sql`select u.screen_name, u.name, u.avatar_url from (
			select o, max(at) as at from (
				select case when sender_id = ${userId}::bigint then recipient_id else sender_id end as o, created_at as at from money_transfers
				where sender_id = ${userId}::bigint or recipient_id = ${userId}::bigint
				union all select followee_id, created_at - interval '100 years' from follows where follower_id = ${userId}::bigint
			) x group by o order by at desc limit 8
		) p join users u on u.id = p.o
		where u.instance is null and u.status <> 'suspended' and u.deactivated_at is null order by p.at desc`;
}

const CSS = `
main{padding:0;gap:0}
.hero{padding:24px 16px 20px;display:grid;justify-items:start;gap:2px;border-bottom:1px solid var(--border)}
.tile{display:grid;place-items:center;width:40px;height:40px;border-radius:10px;background:#000;box-shadow:inset 0 0 0 1px rgb(255 255 255 / .12);margin-bottom:14px}
.tile svg{width:28px;height:28px;fill:#fff}
.hero .label{color:var(--muted)}
.hero .amount{font-size:52px;line-height:60px;font-weight:800;letter-spacing:-1.5px;font-variant-numeric:tabular-nums}
.hero .pill{margin-top:16px}
.pill{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:40px;padding:0 24px;border-radius:9999px;font-weight:700;font-size:15px;text-decoration:none;border:1px solid var(--outline);color:var(--text);background:transparent;cursor:pointer}
.pill.primary{background:var(--text);color:var(--bg);border-color:var(--text)}
.pill.wide{width:100%;min-height:52px;font-size:17px}
.pill svg{width:18px;height:18px;fill:currentColor}
@media (hover:hover){.pill:hover{background:var(--hover);text-decoration:none}.pill.primary:hover{background:var(--text);opacity:.88}}
.notice{margin:12px 16px 0;padding:12px 16px;border-radius:12px;background:rgb(0 186 124 / .12);display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.notice.error{background:rgb(244 33 46 / .12)}
.month{padding:20px 16px 8px;color:var(--muted);font-size:13px;font-weight:700;letter-spacing:.3px;text-transform:uppercase}
.tx{display:grid;grid-template-columns:40px minmax(0,1fr) auto;align-items:center;gap:0 12px;padding:10px 16px;color:var(--text);text-decoration:none}
@media (hover:hover){.tx:hover{background:color-mix(in srgb,var(--text) 4%,transparent);text-decoration:none}}
.tx img{width:40px;height:40px;border-radius:50%;object-fit:cover;background:var(--border)}
.tx .who{display:flex;gap:4px;align-items:center;min-width:0;font-weight:700;white-space:nowrap}
.tx .who span{overflow:hidden;text-overflow:ellipsis}
.tx .sub{color:var(--muted);font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tx .amt{font-weight:700;font-variant-numeric:tabular-nums}
.tx .amt.in{color:var(--success)}
.empty{color:var(--muted);text-align:center;padding:48px 16px}
.send{padding:8px 16px 24px;display:grid;gap:16px;justify-items:stretch}
.picks{display:flex;gap:16px;overflow-x:auto;padding:4px 2px;scrollbar-width:none}
.pick{flex:none;width:60px;display:grid;justify-items:center;gap:6px;border:0;background:none;color:var(--muted);font:inherit;font-size:13px;cursor:pointer;padding:0;min-height:0}
.pick img{width:48px;height:48px;border-radius:50%;object-fit:cover;background:var(--border);outline:2px solid transparent;outline-offset:2px;transition:outline-color .15s}
.pick[aria-pressed="true"]{color:var(--text)}
.pick[aria-pressed="true"] img{outline-color:var(--text)}
.pick span{max-width:60px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.big{display:flex;justify-content:center;align-items:flex-start;padding:28px 0 20px}
.big span{font-size:36px;line-height:48px;font-weight:800;color:var(--muted)}
.big input{all:unset;width:1.2ch;min-width:1.2ch;font-size:72px;line-height:80px;font-weight:800;letter-spacing:-2px;font-variant-numeric:tabular-nums;caret-color:var(--accent)}
.big input::placeholder{color:var(--muted)}
.balance{text-align:center;color:var(--muted);font-size:14px;margin-top:-12px}
.field{position:relative;display:grid}
.field input{padding-top:22px;padding-bottom:6px;min-height:56px}
.field label{position:absolute;left:13px;top:7px;margin:0;font-size:13px;color:var(--muted);pointer-events:none}
.field:focus-within label{color:var(--accent)}
.check{display:flex;align-items:center;justify-content:space-between;gap:10px;color:var(--text);font-size:15px;margin:0}
.check input{appearance:none;width:40px;height:24px;min-height:0;padding:0;border:0;border-radius:9999px;background:var(--field);position:relative;cursor:pointer;transition:background .15s;flex:none}
.check input::after{content:"";position:absolute;top:2px;left:2px;width:20px;height:20px;border-radius:50%;background:#fff;transition:translate .15s}
.check input:checked{background:var(--accent)}
.check input:checked::after{translate:16px 0}
.fine{color:var(--muted);font-size:13px;text-align:center}
.receipt{padding:16px;display:grid;gap:16px}
dl{margin:0;padding:4px 16px 16px;display:grid;grid-template-columns:auto 1fr;gap:14px 16px;border-top:1px solid var(--border);padding-top:16px}
dt{color:var(--muted)}
dd{margin:0;text-align:right;overflow-wrap:anywhere}
details.admin{padding:16px;border-top:1px solid var(--border);color:var(--muted)}
details.admin summary{cursor:pointer;font-size:14px}
details.admin form{margin-top:12px}
.xm-badge{width:18px;height:18px;flex:none}
.xm-card{margin:0;--xm-bg:var(--bg)}
${CARD_CSS}`;

// links on the page that open the client's composer with a payment in it
// (money-ui.ts takes it from there); outside the client it opens the composer page
const COMPOSE = `document.addEventListener("click",function(e){var b=e.target.closest("[data-compose]");if(!b)return;e.preventDefault();var t=b.getAttribute("data-compose");try{parent.__xitterCompose(t)}catch(x){sessionStorage.setItem("xitter-compose",t);top.location.href="/compose/post"}});
document.querySelectorAll(".pick").forEach(function(p){p.addEventListener("click",function(){var to=document.getElementById("to");to.value="@"+p.dataset.handle;document.querySelectorAll(".pick").forEach(function(q){q.setAttribute("aria-pressed",q===p?"true":"false")});document.getElementById("amount").focus()})});
var amt=document.getElementById("amount");if(amt){var fit=function(){amt.style.width=Math.max(1,amt.value.length)*0.62+0.4+"em"};amt.addEventListener("input",fit);fit();if(!amt.value)amt.focus()}
var auto=document.querySelector("[data-compose][data-auto]");if(auto)auto.click();`;
const POST_ICON = "M23 3c-6.62-.1-10.38 2.421-13.05 6.03C7.29 12.61 6 17.331 6 22h2c0-1.007.07-2.012.19-3H12c4.1 0 7.48-3.082 7.94-7.054C22.79 10.147 23.17 6.359 23 3zm-7 8h-1.5v2H16c.63-.016 1.2-.08 1.72-.188C16.95 15.24 14.68 17 12 17H8.55c.57-2.512 1.57-4.851 3-6.78 2.16-2.912 5.29-4.911 9.45-5.187C20.95 8.079 19.9 11 16 11zM4 9V6H1V4h3V1h2v3h3v2H6v3H4z";
const tile = `<span class="tile" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="${MONEY_ICON}"/></svg></span>`;
const page = (req: Request, viewer: Viewer, title: string, body: string, status = 200, back = { href: "/home", label: "Back to home" }) =>
	accountPage({ req, viewer, status, title, back, css: CSS, head: `<script>addEventListener("DOMContentLoaded",function(){${COMPOSE}})</script>`, body });

// the balance and what came and went, by month
async function view(req: Request, viewer: Viewer, status = 200, notice = "", error = "") {
	const [balance, rows] = await Promise.all([balanceOf(viewer.id), activity(viewer.id)]);
	const isAdmin = viewer.role === "admin" && !viewer.actor;
	let month = "";
	const list = rows.length
		? rows
				.map((t: any) => {
					const at = new Date(t.created_at);
					const m = at.toLocaleDateString("en-US", { month: "long", year: "numeric" });
					const head = m !== month ? `<div class="month">${m}</div>` : "";
					month = m;
					const amount = Number(t.amount_cents);
					const what = t.sent ? (t.verified_type === "business" ? "Purchase" : "Sent") : "Received";
					return `${head}<a class="tx" href="/account/money/p/${t.id}"><img src="${esc(avatarUrl(t.avatar_url))}" alt="">
<div><div class="who"><span>${esc(t.name || t.screen_name)}</span>${badge(t.verified_type)}</div><div class="sub">${t.note ? esc(t.note) : what} · ${date(t.created_at)}</div></div>
<div class="amt${t.sent ? "" : " in"}">${t.sent ? "−" : "+"}${shortCents(amount)}</div></a>`;
				})
				.join("\n")
		: `<p class="empty">No activity yet.<br>Money you send and receive shows up here.</p>`;
	return page(
		req,
		viewer,
		"Money",
		`<section class="hero" aria-label="Balance">${tile}<div class="label">Balance</div><div class="amount">${formatCents(balance)}</div>
${viewer.actor ? `<p class="dim">Only @${esc(viewer.screen_name)} can send money from this account.</p>` : `<a class="pill primary" href="/account/money/send">Send</a>`}</section>
${notice ? `<div class="notice" role="status">${notice}</div>` : ""}${error ? `<div class="notice error" role="alert">${esc(error)}</div>` : ""}
<section aria-label="Activity">${list}</section>
${
	isAdmin
		? `<details class="admin"><summary>Adjust a balance (admins)</summary><form method="post" action="/account/money" class="row"><input type="hidden" name="action" value="adjust"><input name="to" required placeholder="@username" aria-label="Username"><input name="amount" required placeholder="20 or -5.00" aria-label="Amount"><button type="submit" class="secondary">Apply</button></form><p class="dim">Never below $0.00. Recorded in the audit log.</p></details>`
		: ""
}`,
		status,
	);
}

// sending, on a screen of its own: who, how much, a note
async function sendView(req: Request, viewer: Viewer, status = 200, form: { to?: string; amount?: string; note?: string } = {}, error = "") {
	const [balance, picks] = await Promise.all([balanceOf(viewer.id), quickPicks(viewer.id)]);
	const to = form.to ?? new URL(req.url).searchParams.get("to") ?? "";
	const chosen = to.replace(/^@/, "").toLowerCase();
	return page(
		req,
		viewer,
		"Send",
		`${error ? `<div class="notice error" role="alert">${esc(error)}</div>` : ""}
<form method="post" action="/account/money/send" class="send" autocomplete="off">
<input type="hidden" name="idem" value="${crypto.randomUUID()}">
<div class="big"><span>$</span><input id="amount" name="amount" required inputmode="decimal" placeholder="0" aria-label="Amount" value="${esc(form.amount ?? "")}"></div>
<div class="balance">${formatCents(balance)} available</div>
${
	picks.length
		? `<div class="picks" role="group" aria-label="People">${picks
				.map((p: any) => `<button type="button" class="pick" data-handle="${esc(p.screen_name)}" aria-pressed="${chosen === p.screen_name.toLowerCase()}"><img src="${esc(avatarUrl(p.avatar_url))}" alt=""><span>${esc(p.name || p.screen_name)}</span></button>`)
				.join("")}</div>`
		: ""
}
<div class="field"><input id="to" name="to" required placeholder=" " value="${esc(to)}" autocapitalize="off" spellcheck="false"><label for="to">To</label></div>
<div class="field"><input id="note" name="note" maxlength="${NOTE_MAX}" placeholder=" " value="${esc(form.note ?? "")}"><label for="note">What's it for?</label></div>
<label class="check">Share it in a post<input type="checkbox" name="share" value="1"></label>
<button type="submit" class="pill primary wide">Send</button>
<p class="fine">Instant and free. ${esc(settings().instance_name)} Money has no cash value.</p>
</form>`,
		status,
		{ href: "/account/money", label: "Back to Money" },
	);
}

// one payment, for either side, or anyone once a side put it in a post
async function receipt(req: Request, viewer: Viewer, id: string) {
	const back = { href: "/account/money", label: "Back to Money" };
	const t = (await payments([id], viewer.id)).get(id);
	if (!t) return page(req, viewer, "Payment", `<p class="empty">This payment doesn't exist, or isn't yours to see.</p>`, 404, back);
	const mine = viewer.id === t.sender.id || viewer.id === t.recipient.id;
	const other = viewer.id === t.sender.id ? t.recipient : t.sender;
	const post = new URL(req.url).searchParams.has("post");
	const who = (p: Party) => `<a href="/${esc(p.screen_name)}">${esc(p.name)}</a>`;
	return page(
		req,
		viewer,
		"Payment",
		`<section class="receipt">${cardHtml(t, (mine ? viewer.screen_name : t.sender.screen_name).toLowerCase())}
${mine ? `<div class="row"><button type="button" class="pill primary" data-compose="${esc(paymentUrl(t.id))}"${post ? " data-auto" : ""}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${POST_ICON}"/></svg>Post</button><a class="pill" href="/account/money/send?to=${encodeURIComponent(other.screen_name)}">${viewer.id === t.sender.id ? "Pay again" : "Pay back"}</a></div>` : ""}</section>
<dl>
<dt>From</dt><dd>${who(t.sender)}</dd>
<dt>To</dt><dd>${who(t.recipient)}</dd>
<dt>Amount</dt><dd>${formatCents(t.amount)}</dd>
<dt>Date</dt><dd>${t.at.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}</dd>
<dt>Status</dt><dd style="color:var(--success)">Completed</dd>
</dl>`,
		200,
		back,
	);
}

export async function moneyRoute(req: Request, viewer: Viewer): Promise<Response> {
	if (!feature("money") || viewer.instance)
		return accountPage({ req, viewer, status: 404, title: "Money", body: `<h1>Money</h1><p>X Money isn't available on ${esc(settings().instance_name)}.</p>` });
	const url = new URL(req.url);
	const one = /^\/account\/money\/p\/(\d{1,19})$/.exec(url.pathname);
	if (one) return receipt(req, viewer, one[1]);
	const sending = url.pathname === "/account/money/send";
	if (!sending && url.pathname !== "/account/money") return new Response("not found", { status: 404 });
	if (req.method !== "POST") {
		if (sending) return viewer.actor ? view(req, viewer, 403, "", `Only @${viewer.screen_name} can send money from this account.`) : sendView(req, viewer);
		const sent = url.searchParams.get("sent");
		const [t] = sent && /^\d{1,19}$/.test(sent) ? await sql`select t.id, t.amount_cents, u.screen_name from money_transfers t join users u on u.id = t.recipient_id where t.id = ${sent}::bigint and t.sender_id = ${viewer.id}::bigint` : [];
		return view(req, viewer, 200, t ? `<span>Sent ${formatCents(Number(t.amount_cents))} to @${esc(t.screen_name)}.</span><button type="button" class="pill" data-compose="${esc(paymentUrl(String(t.id)))}">Post it</button>` : "");
	}
	const form = await req.formData();
	const field = (k: string) => String(form.get(k) ?? "");
	const values = { to: field("to"), amount: field("amount"), note: field("note") };
	if (field("action") === "adjust") {
		if (viewer.role !== "admin" || viewer.actor) return view(req, viewer, 403, "", "Only admins can adjust balances.");
		const negative = values.amount.trim().startsWith("-");
		const cents = parseAmount(values.amount.trim().replace(/^-/, ""));
		if (!cents) return view(req, viewer, 400, "", "Enter an amount, like 20 or -5.00.");
		try {
			const r = await adjust(viewer, values.to, negative ? -cents : cents);
			return view(req, viewer, 200, `@${esc(r.to)} now has ${formatCents(r.balance)}.`);
		} catch (e) {
			if (e instanceof MoneyError) return view(req, viewer, 400, "", e.message);
			throw e;
		}
	}
	if (viewer.actor) return view(req, viewer, 403, "", `Only @${viewer.screen_name} can send money from this account.`);
	const limit = hit("write", viewer.id);
	if (!limit.ok) return sendView(req, viewer, 429, values, "You're sending too fast. Wait a few minutes and try again.");
	const cents = parseAmount(values.amount);
	if (cents === null) return sendView(req, viewer, 400, values, "Enter an amount, like 5 or 12.50.");
	try {
		const r = await sendMoney(viewer.id, values.to, cents, values.note, field("idem"));
		// after a send the page reloads by GET, so going back or refreshing can't send it twice
		const to = field("share") ? `/account/money/p/${r.id}?post=1` : `/account/money?sent=${r.id}`;
		return new Response(null, { status: 303, headers: { location: to } });
	} catch (e) {
		if (e instanceof MoneyError) return sendView(req, viewer, 400, values, e.message);
		throw e;
	}
}
