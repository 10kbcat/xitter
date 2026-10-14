// Rewrites the host names baked into the client so it talks to this instance.
// Applied when a file is served; the archive keeps the original bytes.

import { PUBLIC_HOSTNAME, PUBLIC_ORIGIN } from "./config";

// API hosts the client knows; their paths are served from our root
// Both brand families: the client rewrites "twitter.com" into the current brand
// domain at runtime, which would turn an unpatched api.twitter.com into api.<our host>.
const API_HOSTS = ["api", "upload", "caps", "jf"].flatMap((s) => [`${s}.x.com`, `${s}.twitter.com`]);

// an address as it appears inside a regular expression literal: /https:\/\/a\.b/
const inRegex = (url: string) => url.replace(/[/.]/g, (c) => "\\" + c);

const RULES: [RegExp, string][] = [
	// Chat is a separate app (module federation): its manifest comes from
	// chat.x.com, its files from abs.twimg.com, and both are checked by pattern
	[/https:\/\/chat\.x\.com\/embed-v1\.json/g, `${PUBLIC_ORIGIN}/xchat/embed-v1.json`],
	[new RegExp(String.raw`https:\\\/\\\/chat(\(-staging\)\?)?\\\.x\\\.com\\\/embed-v1\\\.json`, "g"), inRegex(`${PUBLIC_ORIGIN}/xchat/embed-v1.json`)],
	[new RegExp(String.raw`https:\\\/\\\/abs\\\.twimg\\\.com`, "g"), inRegex(`${PUBLIC_ORIGIN}/abs`)],
	[/https:\/\/abs\.twimg\.com/g, `${PUBLIC_ORIGIN}/abs`],
	...API_HOSTS.map((h): [RegExp, string] => [new RegExp(`https://${h.replace(/\./g, "\\.")}`, "g"), PUBLIC_ORIGIN]),
	...API_HOSTS.map((h): [RegExp, string] => [new RegExp(`"${h.replace(/\./g, "\\.")}"`, "g"), `"${PUBLIC_HOSTNAME}"`]),
	// the chat app's own list of API hosts (it sends the csrf header only to them)
	...API_HOSTS.map((h): [RegExp, string] => [new RegExp(`\`${h.replace(/\./g, "\\.")}\``, "g"), `\`${PUBLIC_HOSTNAME}\``]),
	// its socket
	[/wss:\/\/chat-ws\.x\.com\/ws/g, `${PUBLIC_ORIGIN.replace(/^http/, "ws")}/xchat/ws`],
	// the key backup realms it trusts ("pinned realms"): ours instead of X's first
	[/https:\/\/realm-a\.x\.com\//g, `${PUBLIC_ORIGIN}/juicebox/`],
	// and the media host for chat attachments
	[/https:\/\/ton\.x\.com/g, PUBLIC_ORIGIN],
	// the site's own links, also when the address is the start of a longer string
	// or template (profile hrefs, share links); subdomains are not matched
	[/https:\/\/x\.com(?=["'`$/?#])/g, PUBLIC_ORIGIN],
	// the upload host is assembled from a variable, which would force https and drop the port
	[/`https:\/\/\$\{(\w+)\}\/i\/media\//g, "`${location.origin}/i/media/"],
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
