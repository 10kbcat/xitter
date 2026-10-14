// Turns captured sign-in screens (samples/login, from a HAR) into the templates
// src/onboarding.ts serves: decoded to JSON, with the capturing account's
// details replaced by {{placeholders}}.
// usage: bun scripts/jf-templates.ts <your x.com username in the capture>

import { mkdirSync, writeFileSync } from "node:fs";
import { decode, mapStrings } from "../src/jetfuel";
import { toJson } from "../src/jetfuel-json";

const [capturedName] = process.argv.slice(2);
if (!capturedName) throw new Error("usage: bun scripts/jf-templates.ts <username in the capture>");

const SOURCES: Record<string, string> = {
	landing: "samples/login/013-GET-onboarding_web_landing.json",
	password: "samples/login/017-POST-web_actions_begin_login.json",
	success: "samples/login/019-POST-web_actions_login_enter_password.json",
	passkey: "samples/login/014-GET-web_remotes_passkey_one_fa.json",
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

mkdirSync("src/jf", { recursive: true });
for (const [name, file] of Object.entries(SOURCES)) {
	const j = JSON.parse(await Bun.file(file).text());
	let messages = decode(Buffer.from(j.response, "latin1"));
	messages = mapStrings(messages, (s) => {
		if (s.toLowerCase() === capturedName.toLowerCase()) return "{{username}}";
		if (UUID.test(s)) return "{{session_token}}";
		if (/^\d{15,20}$/.test(s)) return "{{user_id}}";
		return s;
	});
	writeFileSync(`src/jf/${name}.json`, JSON.stringify(toJson(messages)));
	console.log(`src/jf/${name}.json`);
}
