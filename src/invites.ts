// Sign-up by invite. Codes come from scripts/invite.ts for now and from the
// admin panel later. A code is spent in the same transaction that creates the
// account, so two people can't both use its last use.

import { sql } from "./db";
import { isFlag } from "./flags";
import { newId } from "./ids";

// no 0/O or 1/I/L, so a code read aloud or typed from a screenshot comes out right
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function newCode(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(12));
	const chars = [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join("");
	return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8)}`;
}

export const normalizeCode = (code: string) => code.trim().toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/(.{4})(?=.)/g, "$1-");

export async function createInvite(opts: { createdBy?: string; maxUses?: number; expiresAt?: Date } = {}): Promise<string> {
	const code = newCode();
	await sql`insert into invites (code, created_by, max_uses, expires_at)
		values (${code}, ${opts.createdBy ?? null}::bigint, ${opts.maxUses ?? 1}, ${opts.expiresAt ?? null})`;
	return code;
}

// Handles that would clash with the client's own pages (x.com/<name> is a
// profile, so /home or /settings can't be one) or pretend to be staff.
const RESERVED = new Set(
	"home explore notifications messages chat settings search compose i login logout signup signin register admin root api public media abs abouts about tos privacy help support account accounts verified premium jobs grok lists bookmarks communities topics hashtag intent share oauth xitter twitter x moderator mod staff system".split(" "),
);

export class SignupError extends Error {}

export async function signUp(f: { code: string; screenName: string; name: string; password: string; flag?: string }): Promise<string> {
	const screenName = f.screenName.trim().replace(/^@/, "");
	const name = f.name.trim() || screenName;
	if (!/^[A-Za-z0-9_]{4,15}$/.test(screenName)) throw new SignupError("Usernames are 4 to 15 letters, digits or underscores.");
	if (RESERVED.has(screenName.toLowerCase())) throw new SignupError("That username is reserved.");
	if ([...name].length > 50) throw new SignupError("Names are at most 50 characters.");
	if (f.password.length < 8) throw new SignupError("Passwords are at least 8 characters.");
	const flag = isFlag(f.flag) ? f.flag : null;
	const hash = await Bun.password.hash(f.password);
	const code = normalizeCode(f.code);
	const id = newId();
	await sql.begin(async (tx) => {
		const [taken] = await tx`select 1 from users where lower(screen_name) = lower(${screenName})`;
		if (taken) throw new SignupError("That username is taken.");
		const [invite] = await tx`update invites set uses = uses + 1
			where code = ${code} and uses < max_uses and (expires_at is null or expires_at > now()) returning code`;
		if (!invite) throw new SignupError("That invite code is not valid or has been used up.");
		await tx`insert into users (id, screen_name, name, password_hash, invite_code, flag) values (${id}::bigint, ${screenName}, ${name}, ${hash}, ${code}, ${flag})`;
	});
	return id;
}
