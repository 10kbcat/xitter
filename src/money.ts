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
import { newId } from "./ids";
import { hit } from "./ratelimit";
import { feature, hasBlockedPhrase, settings } from "./settings";
import { MONEY_ICON } from "./tidy";

export const NOTE_MAX = 140;
const DEFAULT_AVATAR = "/abs/sticky/default_profile_images/default_profile_normal.png";

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

async function activity(userId: string) {
	return sql`select t.id, t.amount_cents, t.note, t.created_at, t.sender_id = ${userId}::bigint as sent,
			o.screen_name, o.name, o.avatar_url, o.verified_type
		from money_transfers t
		join users o on o.id = case when t.sender_id = ${userId}::bigint then t.recipient_id else t.sender_id end
		where t.sender_id = ${userId}::bigint or t.recipient_id = ${userId}::bigint
		order by t.id desc limit 50`;
}

const CSS = `
.wallet{position:relative;overflow:hidden;border-radius:20px;padding:20px;background:#0f0f0f;color:#fff;display:grid;gap:4px;border:1px solid #2f3336}
.wallet .mark{width:44px;height:44px;border-radius:12px;background:#000;border:1px solid #2f3336;display:grid;place-items:center;margin-bottom:12px}
.wallet .mark svg{width:28px;height:28px;fill:#fff}
.wallet .label{color:#a0a4a8;font-size:14px}
.wallet .amount{font-size:44px;line-height:48px;font-weight:800;letter-spacing:-.5px;font-variant-numeric:tabular-nums}
.send{display:grid;gap:12px;justify-items:stretch}
.send .money{position:relative}
.send .money input{padding-left:28px;font-size:20px;font-weight:700}
.send .money::before{content:"$";position:absolute;left:12px;top:50%;translate:0 -50%;font-size:20px;font-weight:700;color:var(--muted);pointer-events:none}
.send button{justify-self:stretch;min-height:44px;font-size:16px}
.counter{justify-self:end;font-size:13px;color:var(--muted);margin-top:-8px;font-variant-numeric:tabular-nums}
.tx{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 12px;padding:14px 16px;border-radius:16px;background:var(--surface);border:1px solid var(--border)}
.tx .amt{font-size:28px;line-height:34px;font-weight:800;font-variant-numeric:tabular-nums}
.tx .amt.in{color:var(--success)}
.tx .who{color:var(--muted)}
.tx .who b{color:var(--text)}
.tx .note{color:var(--muted);font-size:14px;white-space:pre-wrap}
.tx .when{color:var(--muted);font-size:13px;align-self:end;text-align:right}
.tx .faces{display:flex;justify-content:flex-end;align-self:start}
.tx .faces img{width:32px;height:32px;border-radius:50%;object-fit:cover;border:2px solid var(--surface);background:var(--border)}
.tx .faces img+img{margin-left:-10px}
.empty{color:var(--muted);text-align:center;padding:24px 0}
`;

const date = (d: Date) => new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", ...(new Date(d).getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}) });
const avatar = (url: string | null) => esc(url ?? DEFAULT_AVATAR);

async function view(req: Request, viewer: Viewer, status = 200, form: { to?: string; amount?: string; note?: string } = {}, notice = "", error = "") {
	const [balance, rows, [me]] = await Promise.all([balanceOf(viewer.id), activity(viewer.id), sql`select avatar_url from users where id = ${viewer.id}::bigint`]);
	const url = new URL(req.url);
	const to = form.to ?? url.searchParams.get("to") ?? "";
	const isAdmin = viewer.role === "admin" && !viewer.actor;
	const list = rows.length
		? rows
				.map((t: any) => {
					const amount = Number(t.amount_cents);
					return `<article class="tx"><div class="amt${t.sent ? "" : " in"}">${t.sent ? "" : "+"}${shortCents(amount)}</div>
<div class="faces">${t.sent ? `<img src="${avatar(me?.avatar_url)}" alt=""><img src="${avatar(t.avatar_url)}" alt="">` : `<img src="${avatar(t.avatar_url)}" alt=""><img src="${avatar(me?.avatar_url)}" alt="">`}</div>
<div class="who">${t.sent ? "sent to" : "from"} <a href="/${esc(t.screen_name)}"><b>${esc(t.name)}</b></a> <span class="dim">@${esc(t.screen_name)}</span></div>
<div class="when"><time datetime="${new Date(t.created_at).toISOString()}">${date(t.created_at)}</time></div>
${t.note ? `<div class="note">“${esc(t.note)}”</div>` : ""}</article>`;
				})
				.join("\n")
		: `<p class="empty">No payments yet. Money you send and receive shows up here.</p>`;
	return accountPage({
		req,
		viewer,
		status,
		title: "Money",
		back: { href: "/home", label: "Back to home" },
		css: CSS,
		body: `<section class="wallet" aria-label="Balance"><div class="mark"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${MONEY_ICON}"/></svg></div>
<div class="label">X Money balance</div><div class="amount">${formatCents(balance)}</div></section>
${notice ? `<p class="card success" role="status">${notice}</p>` : ""}${error ? `<p class="error" role="alert">${esc(error)}</p>` : ""}
${
	viewer.actor
		? `<p class="dim">Only @${esc(viewer.screen_name)} can send money from this account.</p>`
		: `<h2>Send money</h2>
<form method="post" class="send" autocomplete="off">
<input type="hidden" name="idem" value="${crypto.randomUUID()}">
<label for="to">To</label><input id="to" name="to" required placeholder="@username" value="${esc(to)}" autocapitalize="off" spellcheck="false">
<label for="amount">Amount</label><div class="money"><input id="amount" name="amount" required inputmode="decimal" placeholder="0.00" value="${esc(form.amount ?? "")}"></div>
<label for="note">Note</label><input id="note" name="note" maxlength="${NOTE_MAX}" placeholder="What's it for? (optional)" value="${esc(form.note ?? "")}">
<button type="submit">Send</button>
</form>
<p class="dim">Payments are instant and free. Money here is ${esc(settings().instance_name)}'s own and has no cash value.</p>`
}
<h2>Activity</h2>
${list}
${
	isAdmin
		? `<h2>Adjust a balance</h2><p class="dim">Admins only. A negative amount takes money away, never below $0.00. Recorded in the audit log.</p>
<form method="post" class="row"><input type="hidden" name="action" value="adjust"><input name="to" required placeholder="@username" aria-label="Username"><input name="amount" required placeholder="-5.00 or 20" aria-label="Amount"><button type="submit" class="secondary">Apply</button></form>`
		: ""
}`,
	});
}

export async function moneyRoute(req: Request, viewer: Viewer): Promise<Response> {
	if (!feature("money") || viewer.instance)
		return accountPage({ req, viewer, status: 404, title: "Money", body: `<h1>Money</h1><p>X Money isn't available on ${esc(settings().instance_name)}.</p>` });
	const url = new URL(req.url);
	if (req.method !== "POST") {
		const sent = url.searchParams.get("sent");
		const [t] = sent && /^\d{1,19}$/.test(sent) ? await sql`select t.amount_cents, u.screen_name from money_transfers t join users u on u.id = t.recipient_id where t.id = ${sent}::bigint and t.sender_id = ${viewer.id}::bigint` : [];
		return view(req, viewer, 200, {}, t ? `Sent ${formatCents(Number(t.amount_cents))} to @${esc(t.screen_name)}.` : "");
	}
	const form = await req.formData();
	const field = (k: string) => String(form.get(k) ?? "");
	const values = { to: field("to"), amount: field("amount"), note: field("note") };
	if (field("action") === "adjust") {
		if (viewer.role !== "admin" || viewer.actor) return view(req, viewer, 403, {}, "", "Only admins can adjust balances.");
		const negative = values.amount.trim().startsWith("-");
		const cents = parseAmount(values.amount.trim().replace(/^-/, ""));
		if (!cents) return view(req, viewer, 400, {}, "", "Enter an amount, like 20 or -5.00.");
		try {
			const r = await adjust(viewer, values.to, negative ? -cents : cents);
			return view(req, viewer, 200, {}, `@${esc(r.to)} now has ${formatCents(r.balance)}.`);
		} catch (e) {
			if (e instanceof MoneyError) return view(req, viewer, 400, {}, "", e.message);
			throw e;
		}
	}
	if (viewer.actor) return view(req, viewer, 403, values, "", `Only @${viewer.screen_name} can send money from this account.`);
	const limit = hit("write", viewer.id);
	if (!limit.ok) return view(req, viewer, 429, values, "", "You're sending too fast. Wait a few minutes and try again.");
	const cents = parseAmount(values.amount);
	if (cents === null) return view(req, viewer, 400, values, "", "Enter an amount, like 5 or 12.50.");
	try {
		const r = await sendMoney(viewer.id, values.to, cents, values.note, field("idem"));
		// after a send the page reloads by GET, so going back or refreshing can't send it twice
		return new Response(null, { status: 303, headers: { location: `/account/money?sent=${r.id}` } });
	} catch (e) {
		if (e instanceof MoneyError) return view(req, viewer, 400, values, "", e.message);
		throw e;
	}
}
