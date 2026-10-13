// Downloads client files into the local archive.
// usage: bun scripts/fetch-client.ts [list.txt ...]
// Each list holds one CDN URL per line; defaults to the lists produced by har-extract.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CDN_ORIGIN, getClientFile, readCached } from "../src/client-cache";

let lists = process.argv.slice(2);
if (!lists.length && existsSync("samples"))
	lists = readdirSync("samples")
		.map((d) => join("samples", d, "_client-files.txt"))
		.filter(existsSync);

const paths = new Set<string>();
for (const l of lists)
	for (const line of readFileSync(l, "utf8").split("\n")) {
		const url = line.trim();
		if (url.startsWith(CDN_ORIGIN + "/")) paths.add(new URL(url).pathname);
	}

let fetched = 0;
let failed = 0;
const queue = [...paths].filter((p) => !readCached(p));
console.log(`${paths.size} files listed, ${queue.length} to download`);
await Promise.all(
	Array.from({ length: 8 }, async () => {
		for (let p = queue.pop(); p; p = queue.pop()) {
			if (await getClientFile(p)) fetched++;
			else {
				failed++;
				console.log(`failed: ${p}`);
			}
		}
	}),
);
console.log(`downloaded ${fetched}, failed ${failed}`);
