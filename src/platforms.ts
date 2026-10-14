import { createHash, randomBytes } from "node:crypto";
import { sql } from "./db";
import { newId } from "./ids";

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

export async function createPlatform(label: string, actorId: string) {
	const token = `xitter_${randomBytes(32).toString("hex")}`;
	const id = newId();
	await sql`insert into client_platforms (id, label, token_hash, creator_id) values (${id}::bigint, ${label}, ${hash(token)}, ${actorId}::bigint)`;
	return { id, label, token };
}

export async function platformSource(req: Request): Promise<string | null> {
	const token = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "")?.[1];
	if (!token?.startsWith("xitter_")) return "Xitter for Web";
	const [platform] = await sql`select label from client_platforms where token_hash = ${hash(token)} and not revoked`;
	return platform?.label ?? null;
}
