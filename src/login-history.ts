// Sign-ins, for Settings > Your account > Account access history (the
// client reads them from p13n_data's login_history) and for the admin
// panel's sessions list.
//
// The address is the socket's, or Cloudflare's CF-Connecting-IP when the site
// sits behind it (the same trust countries.ts gives CF-IPCountry). Bun only
// knows the socket address through the server, so server.ts notes it per request.

import { countryFromHeader, countryName } from "./countries";
import { sql } from "./db";
import { newId } from "./ids";
import { platformSource, webSource } from "./platforms";

const socketIps = new WeakMap<Request, string>();
export const rememberIp = (req: Request, ip: string | undefined) => {
	if (ip) socketIps.set(req, ip);
};
export const requestIp = (req: Request): string | null => req.headers.get("cf-connecting-ip")?.trim() || socketIps.get(req) || null;

export async function recordSignIn(req: Request, session: { token: string; userId: string }) {
	const ip = requestIp(req);
	const country = countryFromHeader(req.headers.get("cf-ipcountry")) ?? null;
	const app = (await platformSource(req)) ?? webSource();
	await sql`insert into login_events (id, user_id, ip, country, app, user_agent)
		values (${newId()}::bigint, ${session.userId}::bigint, ${ip}, ${country}, ${app}, ${(req.headers.get("user-agent") ?? "").slice(0, 500)})`;
	await sql`update sessions set ip = ${ip} where token = ${session.token}`;
}

// newest first, as the settings page lists them
export async function loginHistory(userId: string, limit = 50) {
	const rows = await sql`select ip, country, app, created_at from login_events where user_id = ${userId}::bigint order by created_at desc limit ${limit}`;
	return rows.map((r: any) => ({ app_name: r.app, time: r.created_at.toISOString(), ip: r.ip ?? "", country: r.country ? (countryName(r.country) ?? r.country) : null }));
}
