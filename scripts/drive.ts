// Drives the real client in headless Edge over the DevTools protocol: opens a
// page, then runs steps in order. Uses the signed-in profile left by probe.sh
// (PROFILE=<dir> for another, e.g. a fresh one to be signed out).
// usage: bun scripts/drive.ts <path> <step>...
// steps:
//   wait:<seconds>         let the page work
//   click:<text>           click the innermost visible element whose text is exactly <text>
//   css:<selector>         click the first element matching <selector>
//   type:<text>            insert text at the focused element
//   keys:<text>            type it key by key
//   press:<key>            press one key (Enter, Escape, ...)
//   file:<selector>=<path> put a local file into a file input
//   shot:<name>            screenshot to .probe/<name>.png
//   eval:<expression>      print the value of a JS expression
//   mark                   forget errors seen so far
// Console errors are printed at the end. NET=1 prints requests, EXCEPTIONS=1 caught exceptions.
// Git Bash rewrites an argument that starts with "/", so the path's slash is optional.

import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const [pathArg = "home", ...steps] = process.argv.slice(2);
const page = `/${pathArg.replace(/^\/+/, "")}`;
const origin = `http://localhost:${process.env.PORT ?? 3000}`;
const debugPort = 9378;
const EDGE = ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].find(existsSync);
if (!EDGE) throw new Error("Edge not found");

const edge = spawn(EDGE, [
	"--headless=new",
	"--disable-gpu",
	"--no-first-run",
	"--window-size=1280,1600",
	`--remote-debugging-port=${debugPort}`,
	`--user-data-dir=${resolve(process.env.PROFILE ?? ".probe/profile")}`,
	"about:blank",
]);

async function target(): Promise<string> {
	for (let i = 0; i < 50; i++) {
		try {
			const list: any[] = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
			const t = list.find((t) => t.type === "page");
			if (t) return t.webSocketDebuggerUrl;
		} catch {}
		await Bun.sleep(200);
	}
	throw new Error("browser did not start");
}

const ws = new WebSocket(await target());
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let nextId = 0;
const waiting = new Map<number, (v: any) => void>();
const consoleErrors = new Map<string, number>();
// with EXCEPTIONS=1, exceptions the client catches itself are listed too (noise as in js-errors.ts)
const exceptions = new Map<string, number>();
const requests = new Map<string, string>();
const NOISE = /DetermineComponentFrameRoot|^\d*x? ?Promise|React error #460|Invalid URL|^Error  at/;
ws.addEventListener("message", (ev) => {
	const msg = JSON.parse(String(ev.data));
	if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
		const text = msg.params.args.map((a: any) => a.value ?? a.description ?? "").join(" ").split("\n").slice(0, 3).join(" | ").slice(0, 400);
		consoleErrors.set(text, (consoleErrors.get(text) ?? 0) + 1);
	}
	// with NET=1, requests outside the client's own files are printed as they finish or fail
	if (process.env.NET && msg.method === "Network.requestWillBeSent" && !/\/abs\/|^data:/.test(msg.params.request.url))
		requests.set(
			msg.params.requestId,
			`${msg.params.request.method} ${msg.params.request.url.slice(0, 160)}` +
				// NET=2: also the header names and the script that sent it
				(process.env.NET === "2"
					? ` [${Object.keys(msg.params.request.headers).join(",")}] from ${(msg.params.initiator?.stack?.callFrames ?? []).slice(0, 2).map((f: any) => `${f.url.split("/").pop()}:${f.lineNumber}`).join(" < ")}`
					: ""),
		);
	if (process.env.NET && msg.method === "Network.responseReceived" && requests.has(msg.params.requestId))
		console.log(`net ${msg.params.response.status} ${requests.get(msg.params.requestId)}`);
	if (process.env.NET && msg.method === "Network.loadingFailed" && requests.has(msg.params.requestId))
		console.log(`net FAILED ${msg.params.errorText} ${requests.get(msg.params.requestId)}`);
	if (msg.method === "Debugger.paused") {
		const { reason, data, callFrames } = msg.params;
		if (reason === "exception" || reason === "promiseRejection") {
			const text = String(data?.description ?? data?.value ?? "?").split("\n")[0];
			const frames = (callFrames as any[]).slice(0, 3).map((c) => `${c.functionName || "(anonymous)"} ${String(c.url).split("/").pop()}:${c.location.lineNumber + 1}:${c.location.columnNumber}`).join(" < ");
			const key = `${text}  at ${frames}`;
			if (!NOISE.test(key)) exceptions.set(key, (exceptions.get(key) ?? 0) + 1);
		}
		ws.send(JSON.stringify({ id: ++nextId, method: "Debugger.resume" }));
	}
	if (msg.id && waiting.has(msg.id)) {
		waiting.get(msg.id)!(msg.error ? { error: msg.error } : msg.result);
		waiting.delete(msg.id);
	}
});
const call = (method: string, params: object = {}): Promise<any> =>
	new Promise((r) => {
		const id = ++nextId;
		waiting.set(id, r);
		ws.send(JSON.stringify({ id, method, params }));
	});
const evaluate = async (expression: string) =>
	(await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result?.value;

await call("Page.enable");
await call("Runtime.enable");
if (process.env.NET) await call("Network.enable");
if (process.env.EXCEPTIONS) {
	await call("Debugger.enable");
	await call("Debugger.setPauseOnExceptions", { state: "all" });
}
await call("DOM.enable");
// WIDTH=<px> tries other layouts (the side bar narrows under 1265, phones under 500)
const width = Number(process.env.WIDTH ?? 1280);
await call("Emulation.setDeviceMetricsOverride", { width, height: 1600, deviceScaleFactor: 1, mobile: width < 500 });
await call("Page.navigate", { url: origin + page });
await Bun.sleep(6000);

// every element, also inside open shadow roots (the chat app draws in one)
const DEEP = `const deepAll = (root = document) => { const out = []; for (const e of root.querySelectorAll("*")) { out.push(e); if (e.shadowRoot) out.push(...deepAll(e.shadowRoot)); } return out; };
	const deepQuery = (sel) => deepAll().find((e) => e.matches(sel));`;

// the innermost visible element with exactly this text, clicked like a user would
const clickText = (text: string) => `(() => {
	${DEEP}
	const want = ${JSON.stringify(text)};
	const all = deepAll().filter((e) => e.innerText?.trim() === want && e.getClientRects().length);
	const el = all.find((e) => ![...e.children].some((c) => c.innerText?.trim() === want)) ?? all[0];
	if (!el) return "not found";
	const target = el.closest("a,button,[role=button],[role=menuitem],[role=tab],[role=link]") ?? el;
	target.click();
	return "clicked " + target.tagName + (target.getAttribute("role") ? "[" + target.getAttribute("role") + "]" : "");
})()`;

for (const step of steps) {
	const i = step.indexOf(":");
	const [kind, arg] = [step.slice(0, i), step.slice(i + 1)];
	if (step === "mark") {
		// report only what happens after this point
		exceptions.clear();
		consoleErrors.clear();
	} else if (kind === "wait") await Bun.sleep(Number(arg) * 1000);
	else if (kind === "click") console.log(`click ${arg}: ${await evaluate(clickText(arg))}`);
	else if (kind === "css") console.log(`css ${arg}: ${await evaluate(`(() => { ${DEEP} const e = deepQuery(${JSON.stringify(arg)}); if (!e) return "not found"; e.focus?.(); e.click(); return "clicked"; })()`)}`);
	else if (kind === "type") await call("Input.insertText", { text: arg });
	else if (kind === "press") {
		await call("Input.dispatchKeyEvent", { type: "keyDown", key: arg, code: arg, windowsVirtualKeyCode: arg === "Enter" ? 13 : 0, ...(arg === "Enter" ? { text: String.fromCharCode(13) } : {}) });
		await call("Input.dispatchKeyEvent", { type: "keyUp", key: arg, code: arg, windowsVirtualKeyCode: arg === "Enter" ? 13 : 0 });
	}
	// key by key, for fields that take one character per box
	else if (kind === "keys")
		for (const ch of arg) {
			await call("Input.dispatchKeyEvent", { type: "keyDown", key: ch, text: ch, code: /\d/.test(ch) ? `Digit${ch}` : `Key${ch.toUpperCase()}` });
			await call("Input.dispatchKeyEvent", { type: "keyUp", key: ch, code: /\d/.test(ch) ? `Digit${ch}` : `Key${ch.toUpperCase()}` });
			await Bun.sleep(150);
		}
	else if (kind === "file") {
		const cut = arg.lastIndexOf("=");
		const [selector, file] = [arg.slice(0, cut), arg.slice(cut + 1)];
		const doc = await call("DOM.getDocument", { depth: -1, pierce: true });
		const node = await call("DOM.querySelector", { nodeId: doc.root.nodeId, selector });
		const r = await call("DOM.setFileInputFiles", { nodeId: node.nodeId, files: [resolve(file)] });
		console.log(`file ${selector}: ${r?.error ? JSON.stringify(r.error) : "set"}`);
	} else if (kind === "shot") {
		const r = await call("Page.captureScreenshot", { format: "png" });
		writeFileSync(`.probe/${arg}.png`, Buffer.from(r.data, "base64"));
		console.log(`shot .probe/${arg}.png`);
	} else if (kind === "eval") console.log(`eval: ${JSON.stringify(await evaluate(arg))}`);
	else console.log(`unknown step ${step}`);
}

for (const [text, n] of exceptions) console.log(`exception ${n}x: ${text}`);
for (const [text, n] of consoleErrors) console.log(`console error ${n}x: ${text}`);
ws.close();
edge.kill();
process.exit(0);
