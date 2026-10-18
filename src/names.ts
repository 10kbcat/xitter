// Blocked names (admin panel > Settings): words no handle or display name may
// contain. Sign-up with one is refused; an account that renames itself to one
// is suspended on the spot. Matching ignores case, accents, separators,
// look-alike digits and symbols, and extra repeats, so "N_1-gggg3rr" matches
// "nigger". A doubled letter in the word still needs two in the name, or
// "nigger" would block "Nigeria".

import { sql } from "./db";
import { newId } from "./ids";
import { settings } from "./settings";

// what else can stand for a letter; "1" is both i and l
const LOOKALIKE: Record<string, string> = { a: "4@", b: "8", e: "3", g: "96", i: "1!|", l: "1|", o: "0", s: "5$", t: "7+", z: "2" };

// Letters from other scripts that pass for Latin ones; NFKD already folds
// full-width, bold/italic math and circled letters. Pairs: look-alike, Latin.
const GLYPHS = Object.fromEntries(
	[
		// Cyrillic, including faux-Cyrillic (И for N, Я for R)
		"аaвbеeёeкkмmнhоoрpсcтtуyхxіiїiјjѕsԁdьbъbпnиnйnяrгrшwщwцuчyзeэeдdлnғfқkңhүyұyһhӏl",
		// Greek
		"αaβbγyδdεeζzηnθoιiκkλnμuνvοoπnρpσoςcτtυuφoχxψwωw",
		// small caps and other Latin look-alikes NFKD leaves alone
		"ᴀaʙbᴄcᴅdᴇeɢgʜhɪiᴊjᴋkʟlᴍmɴnᴏoᴘpʀrꜱsᴛtᴜuᴠvᴡwʏyᴢzıiȷjłløođdħhŋnſsɑaɡgɩiʋvƒfßb",
		// symbols that aren't letters but read as one
		"∂d©c®r℗p∑e∆a∏n€e£l¢c¥y∅o⊂c∩n∪u∈e∃e∀a",
	]
		.join("")
		.match(/../gsu)!
		.map((pair) => [...pair] as [string, string]),
);
// capitals that look unlike their small letter (Σ is an E, σ an o)
const CAPITALS: Record<string, string> = { Σ: "e", Δ: "a", Λ: "a", Ξ: "e", Η: "h", Υ: "y", Ν: "n", Μ: "m", Γ: "r" };
// regional indicators (flag letters) 🇦..🇿
const FLAG_A = 0x1f1e6;

// NFKD, no accents, lowercase, every look-alike letter as its Latin one
export function foldGlyphs(text: string): string {
	return text
		.normalize("NFKD")
		.replace(/\p{M}/gu, "")
		.replace(/[ΣΔΛΞΗΥΝΜΓ]/gu, (c) => CAPITALS[c])
		.toLowerCase()
		.replace(/[\u{1F1E6}-\u{1F1FF}]/gu, (c) => String.fromCharCode(97 + c.codePointAt(0)! - FLAG_A))
		.replace(/[^\x00-\x7f]/gu, (c) => GLYPHS[c] ?? c);
}

// lowercase letters plus the look-alike digits and symbols; repeats are kept
export function normalizeName(text: string): string {
	return foldGlyphs(text).replace(/[^\p{L}0-9!|@$+]/gu, "");
}

// "nigger" -> n+[i1!|]+[g96]{2,}[e3]+r+
function wordPattern(word: string): RegExp {
	const letters = word.replace(/[^\p{L}]/gu, "");
	return new RegExp(letters.replace(/(\p{L})\1*/gu, (run, c) => {
		const cls = LOOKALIKE[c] ? `[${c}${LOOKALIKE[c].replace(/[|$+]/g, "\\$&")}]` : c;
		return run.length > 1 ? `${cls}{${run.length},}` : `${cls}+`;
	}), "u");
}

// the first blocked word the text contains, if any
export function blockedNameIn(...texts: string[]): string | undefined {
	const words = settings().operations.blocked_names.filter((w) => /\p{L}/u.test(normalizeName(w)));
	if (!words.length) return undefined;
	const all = texts.map(normalizeName);
	return words.find((w) => {
		const re = wordPattern(normalizeName(w));
		return all.some((t) => re.test(t));
	});
}

// An account that took a blocked name: suspended and signed out everywhere,
// with a line in the audit log. Staff are left alone (the caller refuses).
export async function suspendForName(userId: string, name: string) {
	await sql`update users set status = 'suspended', status_until = null where id = ${userId}::bigint and role is null`;
	await sql`delete from sessions where user_id = ${userId}::bigint and exists (select 1 from users where id = ${userId}::bigint and role is null)`;
	await sql`insert into audit_log (id, actor_id, action, target, detail) values (${newId()}::bigint, null, 'auto_suspend_name', ${userId}, ${JSON.stringify({ name })}::text::jsonb)`;
}
