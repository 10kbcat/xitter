// The public API's account shape carries badges: the checkmark's kind,
// affiliations (the organisation badge), custom badges and pride flags.
// Against a migrated, disposable local database.
import { strict as assert } from "node:assert";
import { sql } from "../src/db";
import { newId } from "../src/ids";
import { createToken, publicApi } from "../src/public-api";
import { PUBLIC_ORIGIN } from "../src/config";

const database = new URL(process.env.DATABASE_URL ?? "postgres://localhost/xitter");
assert(["localhost", "127.0.0.1"].includes(database.hostname) && /test|codex/.test(database.pathname), "Use a disposable local test database.");

const org = newId(), person = newId(), plain = newId(), badge = newId();
const names = { org: `org_${org.slice(-8)}`, person: `aff_${person.slice(-8)}`, plain: `pl_${plain.slice(-8)}` };
const get = async (token: string, path: string) => {
	const url = new URL(`${PUBLIC_ORIGIN}/api/v1${path}`);
	const res = await publicApi(new Request(url, { headers: { authorization: `Bearer ${token}` } }), url);
	assert.equal(res.status, 200, path);
	return (await res.json()).data;
};

try {
	await sql`insert into users(id, screen_name, name, password_hash, verified_type, avatar_url) values
		(${org}::bigint, ${names.org}, 'Example Org', 'unused', 'business', '/media/org.png'),
		(${person}::bigint, ${names.person}, 'Affiliate', 'unused', null, null),
		(${plain}::bigint, ${names.plain}, 'Plain', 'unused', null, null)`;
	await sql`update users set flag = 'pride,trans' where id = ${person}::bigint`;
	await sql`insert into affiliations(org_id, user_id) values(${org}::bigint, ${person}::bigint)`;
	await sql`insert into custom_badges(id, name, image, mime) values(${badge}::bigint, 'Early supporter', '\\x00'::bytea, 'image/png')`;
	await sql`insert into user_badges(user_id, badge_id) values(${person}::bigint, ${badge}::bigint)`;
	const token = await createToken(plain, "badges test", "read");

	const o = await get(token, `/users/${names.org}`);
	assert.equal(o.verified_type, "business");
	assert.equal(o.organization, true, "businesses are organisations");
	assert.equal(o.affiliates_count, 1);
	assert.deepEqual(o.affiliations, []);

	const a = await get(token, `/users/${names.person}`);
	assert.equal(a.organization, false);
	assert.deepEqual(a.affiliations, [{ screen_name: names.org, name: "Example Org", badge_url: `${PUBLIC_ORIGIN}/media/org.png` }], "affiliation with the org's picture");
	assert.deepEqual(a.badges, [
		{ name: "Early supporter", url: `${PUBLIC_ORIGIN}/public/badge-${badge}.png` },
		{ name: "Pride flag", url: `${PUBLIC_ORIGIN}/public/flag-pride.svg` },
		{ name: "Transgender flag", url: `${PUBLIC_ORIGIN}/public/flag-trans.svg` },
	], "custom badges, then flags");
	assert(!("affiliates_count" in a), "only organisations have affiliates");

	const p = await get(token, `/users/${names.plain}`);
	assert.deepEqual([p.affiliations, p.badges, p.organization, p.verified_since], [[], [], false, null], "no badges, no noise");

	// the same shape on post authors
	const post = newId();
	await sql`insert into posts(id, user_id, text, conversation_id) values(${post}::bigint, ${person}::bigint, 'hello', ${post}::bigint)`;
	const got = await get(token, `/posts/${post}`);
	assert.equal(got.author.affiliations[0]?.screen_name, names.org, "post authors carry affiliations");
	console.log("API badge and affiliation checks passed");
} finally {
	await sql`delete from users where id in (${org}::bigint, ${person}::bigint, ${plain}::bigint)`;
	await sql`delete from custom_badges where id = ${badge}::bigint`;
	await sql.close();
}
