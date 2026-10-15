// Settings > Your account: password, deactivation. Username and language go
// through account/settings.json (rest.ts) and use the helpers here.
import { sql } from "./db";
import type { Viewer } from "./auth";

const error = (code: number, message: string, status = 400) => Response.json({ errors: [{ code, message }] }, { status });

async function body(req: Request): Promise<Record<string, string>> {
	const out: Record<string, string> = {};
	const type = req.headers.get("content-type") ?? "";
	if (type.includes("json")) {
		const j = await req.json().catch(() => ({}));
		for (const [k, v] of Object.entries(j as Record<string, unknown>)) if (typeof v === "string") out[k] = v;
		return out;
	}
	const f = await req.formData().catch(() => undefined);
	if (f) for (const [k, v] of f) if (typeof v === "string") out[k] = v;
	return out;
}

async function passwordMatches(userId: string, password: string | undefined): Promise<boolean> {
	if (!password) return false;
	const [u] = await sql`select password_hash from users where id = ${userId}::bigint`;
	return !!u && (await Bun.password.verify(password, u.password_hash).catch(() => false));
}

export async function changeUsername(viewer: Viewer, wanted: string): Promise<string | undefined> {
	if (wanted === viewer.screen_name) return undefined;
	if (!/^[A-Za-z0-9_]{1,15}$/.test(wanted)) return "Usernames can only contain letters, numbers and underscores, up to 15 characters.";
	const [taken] = await sql`select 1 from users where lower(screen_name) = lower(${wanted}) and id <> ${viewer.id}::bigint`;
	if (taken) return "That username has been taken. Please choose another.";
	await sql`insert into username_changes (user_id, old_name, new_name) values (${viewer.id}::bigint, ${viewer.screen_name}, ${wanted})`;
	await sql`update users set screen_name = ${wanted} where id = ${viewer.id}::bigint`;
	return undefined;
}

export async function usernameAvailable(userId: string, wanted: string): Promise<{ available: boolean; suggestions: string[] }> {
	const valid = /^[A-Za-z0-9_]{1,15}$/.test(wanted);
	const [taken] = valid ? await sql`select 1 from users where lower(screen_name) = lower(${wanted}) and id <> ${userId}::bigint` : [{}];
	if (valid && !taken) return { available: true, suggestions: [] };
	const base = wanted.replace(/[^A-Za-z0-9_]/g, "").slice(0, 11) || "user";
	const suggestions: string[] = [];
	for (let i = 0; suggestions.length < 3 && i < 20; i++) {
		const candidate = `${base}${Math.floor(Math.random() * 9000) + 100}`.slice(0, 15);
		const [used] = await sql`select 1 from users where lower(screen_name) = lower(${candidate})`;
		if (!used && !suggestions.includes(candidate)) suggestions.push(candidate);
	}
	return { available: false, suggestions };
}

export async function accountSettingsRoute(method: string, path: string, viewer: Viewer, req: Request): Promise<Response | undefined> {
	if (method !== "POST") return undefined;

	if (/^\/(?:i|1\.1)\/account\/change_password(?:\.json)?$/.test(path)) {
		const f = await body(req);
		if (!(await passwordMatches(viewer.id, f.current_password))) return error(231, "Your current password is incorrect.", 403);
		const next = f.new_password ?? "";
		if (next.length < 8) return error(214, "Your password needs to be at least 8 characters.");
		if (next !== (f.password_confirmation ?? next)) return error(214, "The two passwords don't match.");
		if (next === f.current_password) return error(214, "Your new password must be different from your current one.");
		await sql`update users set password_hash = ${await Bun.password.hash(next)} where id = ${viewer.id}::bigint`;
		// other devices have to sign in again with the new password
		await sql`delete from sessions where user_id = ${viewer.id}::bigint and token <> ${viewer.token}`;
		return Response.json({ status: "ok" });
	}

	if (path === "/1.1/account/verify_password.json") {
		const f = await body(req);
		return (await passwordMatches(viewer.id, f.password)) ? Response.json({ status: "ok" }) : error(231, "Your password is incorrect.", 403);
	}

	if (path === "/1.1/account/deactivate.json") {
		const f = await body(req);
		if (!(await passwordMatches(viewer.id, f.current_password ?? f.password))) return error(231, "Your password is incorrect.", 403);
		if (viewer.role) return error(214, "Staff accounts can't be deactivated here.");
		await sql`update users set status = 'suspended', deactivated_at = now() where id = ${viewer.id}::bigint`;
		await sql`delete from sessions where user_id = ${viewer.id}::bigint`;
		const headers = new Headers();
		for (const n of ["auth_token", "ct0"]) headers.append("set-cookie", `${n}=; Path=/; Max-Age=0`);
		return Response.json({ status: "ok" }, { headers });
	}
	return undefined;
}
