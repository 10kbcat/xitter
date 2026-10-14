import { PUBLIC_ORIGIN } from "./config";
import { sql } from "./db";
import { newId } from "./ids";

export type User = {
	id: string;
	screen_name: string;
	name: string;
	bio: string;
	location: string;
	website?: string;
	avatar_url: string | null;
	banner_url: string | null;
	pinned_post_id?: string | null;
	verified_type: "blue" | "business" | "government" | null;
	created_at: Date;
	// present when the row was loaded through users.ts
	stats?: {
		posts: number;
		likes: number;
		followers: number;
		following: number;
		followedByViewer: boolean;
		followsViewer: boolean;
	};
};

export type Viewer = User & { csrf: string; token: string };

const SECURE = PUBLIC_ORIGIN.startsWith("https:") ? "; Secure" : "";
const YEAR = 60 * 60 * 24 * 365;
const randomHex = (bytes: number) => Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("hex");

export async function createUser(screenName: string, name: string, password: string): Promise<string> {
	if (!/^[A-Za-z0-9_]{1,15}$/.test(screenName)) throw new Error("screen name: 1-15 letters, digits or underscores");
	if (password.length < 8) throw new Error("password: at least 8 characters");
	const id = newId();
	const hash = await Bun.password.hash(password);
	await sql`insert into users (id, screen_name, name, password_hash) values (${id}::bigint, ${screenName}, ${name}, ${hash})`;
	return id;
}

export async function login(screenName: string, password: string): Promise<{ token: string; csrf: string; userId: string } | undefined> {
	const [u] = await sql`select id, password_hash from users where lower(screen_name) = lower(${screenName})`;
	// verify against a dummy hash when the user is unknown so timing does not reveal it
	const ok = await Bun.password.verify(password, u?.password_hash ?? DUMMY_HASH).catch(() => false);
	if (!u || !ok) return undefined;
	const token = randomHex(20);
	const csrf = randomHex(32);
	await sql`insert into sessions (token, user_id, csrf) values (${token}, ${u.id}::bigint, ${csrf})`;
	return { token, csrf, userId: u.id };
}

const DUMMY_HASH = await Bun.password.hash(randomHex(16));

export async function logout(token: string) {
	await sql`delete from sessions where token = ${token}`;
}

export function parseCookies(req: Request): Record<string, string> {
	const out: Record<string, string> = {};
	for (const part of (req.headers.get("cookie") ?? "").split(/;\s*/)) {
		const i = part.indexOf("=");
		if (i > 0) out[part.slice(0, i)] = part.slice(i + 1);
	}
	return out;
}

export async function getViewer(req: Request): Promise<Viewer | undefined> {
	const token = parseCookies(req).auth_token;
	if (!token) return undefined;
	const [row] = await sql`
		select u.id, u.screen_name, u.name, u.bio, u.location, u.website, u.avatar_url, u.banner_url, u.verified_type, u.created_at, s.csrf, s.token
		from sessions s join users u on u.id = s.user_id
		where s.token = ${token}`;
	return row as Viewer | undefined;
}

export function sessionCookies(s: { token: string; csrf: string; userId: string }): string[] {
	const base = `Path=/; Max-Age=${YEAR}; SameSite=Lax${SECURE}`;
	return [
		`auth_token=${s.token}; HttpOnly; ${base}`,
		// the client reads these two itself
		`ct0=${s.csrf}; ${base}`,
		`twid=u%3D${s.userId}; ${base}`,
	];
}

export function clearedCookies(): string[] {
	return ["auth_token", "ct0", "twid"].map((n) => `${n}=; Path=/; Max-Age=0; SameSite=Lax${SECURE}`);
}
