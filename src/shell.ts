// The HTML page that boots the client. Markup, script list and feature switches
// come from the captured page of the pinned build; everything about the
// signed-in account is replaced with our own data.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { User } from "./auth";
import { SAMPLES_DIR } from "./config";
import { legacyUser } from "./model";
import { patchText } from "./patch";

const TEMPLATE = join(SAMPLES_DIR, "login", "020-GET-home.html");
const STATE = /window\.__INITIAL_STATE__=(\{.*?\});window\.__META_DATA__=(\{.*?\});/s;

type Template = { head: string; tail: string; state: any; meta: any };
let template: Template | undefined;

function load(): Template | undefined {
	if (template || !existsSync(TEMPLATE)) return template;
	let html = readFileSync(TEMPLATE, "utf8");
	// bot-check loader of the original site
	html = html.replace(/<script[^>]*\/cdn-cgi\/challenge-platform\/[^>]*><\/script>/g, "");
	// inline script sets cookies for the original domain; the server sets ours
	html = html.replace(/document\.cookie\s*=/g, "window.__droppedCookie=");
	const m = STATE.exec(html);
	if (!m) return undefined;
	template = {
		head: patchText(html.slice(0, m.index)),
		tail: patchText(html.slice(m.index + m[0].length)),
		state: JSON.parse(m[1]),
		meta: JSON.parse(m[2]),
	};
	return template;
}

// account settings as the client expects them, minus anything tied to the captured account
export function settingsFor(user: User): Record<string, unknown> | undefined {
	const t = load();
	if (!t) return undefined;
	const { ext, ...settings } = t.state.settings.remote.settings;
	return { ...settings, screen_name: user.screen_name, protected: false };
}

// JSON placed inside a <script> must not be able to close it
const inline = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");

export function shell(user: User): string | undefined {
	const t = load();
	if (!t) return undefined;
	const state = {
		...t.state,
		entities: {
			...t.state.entities,
			users: { entities: { [user.id]: legacyUser(user) }, errors: {}, fetchStatus: { [user.id]: "loaded" } },
		},
		settings: { ...t.state.settings, remote: { settings: settingsFor(user), fetchStatus: "loaded" } },
		session: { ...t.state.session, user_id: user.id },
		userClaim: { ...t.state.userClaim, config: { subscriptions: {}, features: {} }, commerceSubscriptions: [] },
		educationFlags: {},
	};
	const meta = { ...t.meta, isLoggedIn: true, userId: user.id, serverDate: Date.now() };
	return `${t.head}window.__INITIAL_STATE__=${inline(state)};window.__META_DATA__=${inline(meta)};${t.tail}`;
}
