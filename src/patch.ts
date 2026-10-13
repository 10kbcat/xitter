// Rewrites the host names baked into the client so it talks to this instance.
// Applied when a file is served; the archive keeps the original bytes.

import { PUBLIC_HOSTNAME, PUBLIC_ORIGIN } from "./config";

// API hosts the client knows; their paths are served from our root
// Both brand families: the client rewrites "twitter.com" into the current brand
// domain at runtime, which would turn an unpatched api.twitter.com into api.<our host>.
const API_HOSTS = ["api", "upload", "caps", "jf"].flatMap((s) => [`${s}.x.com`, `${s}.twitter.com`]);

const RULES: [RegExp, string][] = [
	[/https:\/\/abs\.twimg\.com/g, `${PUBLIC_ORIGIN}/abs`],
	...API_HOSTS.map((h): [RegExp, string] => [new RegExp(`https://${h.replace(/\./g, "\\.")}`, "g"), PUBLIC_ORIGIN]),
	...API_HOSTS.map((h): [RegExp, string] => [new RegExp(`"${h.replace(/\./g, "\\.")}"`, "g"), `"${PUBLIC_HOSTNAME}"`]),
	[/"https:\/\/x\.com"/g, `"${PUBLIC_ORIGIN}"`],
	[/https:\/\/x\.com\/i\/(jf)?api/g, `${PUBLIC_ORIGIN}/i/$1api`],
	[/"x\.com"/g, `"${PUBLIC_HOSTNAME}"`],
	// cookie domain; a cookie scoped to the original domain is dropped by the browser
	[/"\.x\.com"/g, `"${PUBLIC_HOSTNAME}"`],
];

export function patchText(text: string): string {
	let out = text;
	for (const [re, to] of RULES) out = out.replace(re, to);
	return out;
}

const cache = new Map<string, Buffer>();

export function patchFile(key: string, raw: Buffer): Buffer {
	let hit = cache.get(key);
	if (!hit) {
		hit = Buffer.from(patchText(raw.toString("utf8")));
		cache.set(key, hit);
	}
	return hit;
}
