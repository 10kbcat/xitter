// Dim (X dropped it) and custom themes. Pure helpers live at the top so unit
// tests can import them without touching db.ts.

import type { Viewer } from "./auth";
import { fontSlug, prepareFonts, validateFamily } from "./fonts";
import { isId } from "./ids";

export type Gradient = { stops: string[]; angle: number };
export type Fill = string | Gradient;
export type ThemeFont = { ui?: string; display?: string };

declare const mediaIdBrand: unique symbol;
declare const dimBrand: unique symbol;
declare const blurBrand: unique symbol;
export type MediaId = string & { readonly [mediaIdBrand]: true };
export type Dim = number & { readonly [dimBrand]: true };
export type BlurPx = number & { readonly [blurBrand]: true };
export type BgFit = "cover" | "contain" | "tile";
export type BgPosition = "center" | "top" | "bottom";

export type ThemeBackground = {
	fit: BgFit;
	position: BgPosition;
	dim: Dim;
	blur: BlurPx;
	mediaId?: MediaId;
};

export type Theme = {
	id: string;
	base: "dark" | "light";
	bg: Gradient;
	surface: Fill;
	text: string;
	accent: Fill;
	button: Gradient;
	buttonText: string;
	link?: string;
	secondary?: string;
	muted?: string;
	border?: string;
	divider?: string;
	hover?: string;
	inputBg?: string;
	inputText?: string;
	inputBorder?: string;
	header?: Fill;
	menu?: Fill;
	tooltip?: string;
	icon?: string;
	iconActive?: string;
	reply?: string;
	repost?: string;
	like?: string;
	bookmark?: string;
	views?: string;
	secondaryButton?: Fill;
	secondaryButtonBorder?: string;
	secondaryButtonText?: string;
	buttonHover?: string;
	badge?: string;
	selection?: string;
	font?: ThemeFont;
	background?: ThemeBackground;
};

export type Sanitised = { theme: Theme; warnings: string[] };

export const TEXT_FIELDS = ["text", "secondary", "muted", "link", "inputText", "buttonText", "secondaryButtonText"] as const;

export const THEME_FORMAT = "xitter-theme" as const;
export const THEME_VERSION = 1 as const;
export const THEME_FILE_MAX = 64 * 1024;
export const THEME_DEPTH_MAX = 6;
export const BACKGROUND_OMITTED = "background image not included; upload it again";

export type ThemeError = { readonly path: string; readonly message: string };
export type ThemeMode = "read" | "save" | "import";
export type ParsedTheme =
	| { readonly ok: true; readonly theme: Theme; readonly warnings: readonly string[] }
	| { readonly ok: false; readonly errors: readonly ThemeError[] };

export type SharedBackground = { fit: BgFit; position: BgPosition; dim: Dim; blur: BlurPx };
export type ImportedTheme = Omit<Theme, "background"> & { background?: SharedBackground };
export type ImportResult =
	| { readonly ok: true; readonly theme: ImportedTheme; readonly warnings: readonly string[] }
	| { readonly ok: false; readonly errors: readonly ThemeError[] };
export type SharedTheme = Omit<Theme, "background"> & { readonly background?: SharedBackground };
export type ThemeFile = { readonly format: typeof THEME_FORMAT; readonly version: typeof THEME_VERSION; readonly theme: SharedTheme };

export type BackgroundPaint = {
	readonly image: string;
	readonly still: string | null;
	readonly fit: BgFit;
	readonly position: BgPosition;
	readonly dim: Dim;
	readonly blur: BlurPx;
};

type FieldKind = "id" | "base" | "hex" | "fill" | "gradient" | "font" | "background";
type FieldSpec<K extends keyof Theme = keyof Theme> = { readonly key: K; readonly kind: FieldKind; readonly required: boolean; readonly share: boolean };

const THEME_FIELDS = [
	{ key: "id", kind: "id", required: true, share: true },
	{ key: "base", kind: "base", required: true, share: true },
	{ key: "bg", kind: "gradient", required: true, share: true },
	{ key: "surface", kind: "fill", required: true, share: true },
	{ key: "text", kind: "hex", required: true, share: true },
	{ key: "accent", kind: "fill", required: true, share: true },
	{ key: "button", kind: "gradient", required: true, share: true },
	{ key: "buttonText", kind: "hex", required: true, share: true },
	{ key: "link", kind: "hex", required: false, share: true },
	{ key: "secondary", kind: "hex", required: false, share: true },
	{ key: "muted", kind: "hex", required: false, share: true },
	{ key: "border", kind: "hex", required: false, share: true },
	{ key: "divider", kind: "hex", required: false, share: true },
	{ key: "hover", kind: "hex", required: false, share: true },
	{ key: "inputBg", kind: "hex", required: false, share: true },
	{ key: "inputText", kind: "hex", required: false, share: true },
	{ key: "inputBorder", kind: "hex", required: false, share: true },
	{ key: "header", kind: "fill", required: false, share: true },
	{ key: "menu", kind: "fill", required: false, share: true },
	{ key: "tooltip", kind: "hex", required: false, share: true },
	{ key: "icon", kind: "hex", required: false, share: true },
	{ key: "iconActive", kind: "hex", required: false, share: true },
	{ key: "reply", kind: "hex", required: false, share: true },
	{ key: "repost", kind: "hex", required: false, share: true },
	{ key: "like", kind: "hex", required: false, share: true },
	{ key: "bookmark", kind: "hex", required: false, share: true },
	{ key: "views", kind: "hex", required: false, share: true },
	{ key: "secondaryButton", kind: "fill", required: false, share: true },
	{ key: "secondaryButtonBorder", kind: "hex", required: false, share: true },
	{ key: "secondaryButtonText", kind: "hex", required: false, share: true },
	{ key: "buttonHover", kind: "hex", required: false, share: true },
	{ key: "badge", kind: "hex", required: false, share: true },
	{ key: "selection", kind: "hex", required: false, share: true },
	{ key: "font", kind: "font", required: false, share: true },
	{ key: "background", kind: "background", required: false, share: true },
] as const satisfies readonly FieldSpec[];

const BACKGROUND_FIELDS = [
	{ key: "fit", share: true, onImport: "take" },
	{ key: "position", share: true, onImport: "take" },
	{ key: "dim", share: true, onImport: "take" },
	{ key: "blur", share: true, onImport: "take" },
	{ key: "mediaId", share: false, onImport: "forbid" },
] as const;

const FONT_KEYS = ["ui", "display"] as const;
const BANNED_KEYS = ["__proto__", "constructor", "prototype"] as const;
const IMPORT_FORBIDDEN = ["mediaId", "url", "src", "href"] as const;
const FITS = ["cover", "contain", "tile"] as const;
const POSITIONS = ["center", "top", "bottom"] as const;
const KEY_CAP = THEME_FIELDS.length + 8;
const ARRAY_CAP = 5;

type Listed = (typeof THEME_FIELDS)[number]["key"];
type FieldsCoverTheme = Exclude<keyof Theme, Listed> extends never ? (Exclude<Listed, keyof Theme> extends never ? true : never) : never;
const fieldsCoverTheme: FieldsCoverTheme = true;
void fieldsCoverTheme;

export const OPTIONAL_HEX = THEME_FIELDS.filter((f) => f.kind === "hex" && !f.required).map((f) => f.key);
export const OPTIONAL_FILL = THEME_FIELDS.filter((f) => f.kind === "fill" && !f.required).map((f) => f.key);
export const GRADIENT_FIELDS = THEME_FIELDS.filter((f) => f.kind === "gradient" || f.kind === "fill").map((f) => f.key);

const HEX3 = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i;
const HEX6 = /^#([0-9a-f]{6})$/i;
const CHIRP = `TwitterChirp,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif`;
export const FONT_SUGGESTIONS = [
	"Inter",
	"Roboto",
	"Open Sans",
	"Lato",
	"Montserrat",
	"Poppins",
	"Nunito",
	"Raleway",
	"Source Sans 3",
	"Work Sans",
	"DM Sans",
	"Manrope",
	"IBM Plex Sans",
	"Space Grotesk",
	"JetBrains Mono",
	"Merriweather",
	"Playfair Display",
	"Lora",
	"Fira Sans",
	"Rubik",
	"Outfit",
	"Comic Neue",
	"Press Start 2P",
	"Lexend",
];

export function parseHex(v: unknown): string | undefined {
	if (typeof v !== "string") return;
	const s = v.trim().toLowerCase();
	const m6 = HEX6.exec(s);
	if (m6) return `#${m6[1]}`;
	const m3 = HEX3.exec(s);
	if (m3) return `#${m3[1]}${m3[1]}${m3[2]}${m3[2]}${m3[3]}${m3[3]}`;
}

function rgb(h: string): [number, number, number] {
	return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
}

function toHex(r: number, g: number, b: number): string {
	return `#${[r, g, b]
		.map((n) => Math.round(Math.max(0, Math.min(255, n)))
			.toString(16)
			.padStart(2, "0"))
		.join("")}`;
}

export function mixHex(a: string, b: string, t: number): string {
	const A = rgb(a),
		B = rgb(b);
	return toHex(A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t);
}

export function averageHex(stops: string[]): string {
	const rs = stops.map(rgb);
	const n = rs.length || 1;
	return toHex(
		rs.reduce((s, c) => s + c[0], 0) / n,
		rs.reduce((s, c) => s + c[1], 0) / n,
		rs.reduce((s, c) => s + c[2], 0) / n,
	);
}

function lin(c: number): number {
	const s = c / 255;
	return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function lum(h: string): number {
	const [r, g, b] = rgb(h);
	return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrast(a: string, b: string): number {
	const L1 = lum(a),
		L2 = lum(b);
	const [hi, lo] = L1 > L2 ? [L1, L2] : [L2, L1];
	return (hi + 0.05) / (lo + 0.05);
}

const WHITE = "#ffffff";
const INK = "#0f1419";
const REPOST = "#00ba7c";
const LIKE = "#f91880";

function readableOn(bgs: string[]): string {
	const score = (t: string) => Math.min(...bgs.map((bg) => contrast(t, bg)));
	return score(WHITE) >= score(INK) ? WHITE : INK;
}

function intAngle(v: unknown): number | undefined {
	const n = typeof v === "number" ? v : typeof v === "string" && /^-?\d+$/.test(v.trim()) ? Number(v.trim()) : NaN;
	if (!Number.isInteger(n) || n < 0 || n > 360) return;
	return n;
}

function parseGradient(v: unknown): Gradient | undefined {
	if (!v || typeof v !== "object") return;
	const g = v as Record<string, unknown>;
	if (!Array.isArray(g.stops) || g.stops.length < 1 || g.stops.length > 5) return;
	const stops = g.stops.map(parseHex);
	if (stops.some((s) => !s)) return;
	const angle = intAngle(g.angle);
	if (angle === undefined) return;
	return { stops: stops as string[], angle };
}

function parseGradientOrHex(v: unknown): Gradient | undefined {
	const h = parseHex(v);
	if (h) return { stops: [h], angle: 180 };
	return parseGradient(v);
}

function parseFill(v: unknown): Fill | undefined {
	const h = parseHex(v);
	if (h) return h;
	return parseGradient(v);
}

export function solidOf(f: Fill): string {
	return typeof f === "string" ? f : averageHex(f.stops);
}

export function stopsOf(f: Fill): string[] {
	return typeof f === "string" ? [f] : f.stops;
}

export const ACCENT_IDS = ["blue500", "yellow500", "magenta500", "purple500", "orange500", "green500"] as const;
export type AccentId = (typeof ACCENT_IDS)[number];
export const ACCENTS: Record<AccentId, string> = {
	blue500: "#1d9bf0",
	yellow500: "#ffd400",
	magenta500: "#f91880",
	purple500: "#7856ff",
	orange500: "#ff7a00",
	green500: "#00ba7c",
};
const ACCENT_ID_SET = new Set<string>(ACCENT_IDS);
const HEX_TO_ACCENT = Object.fromEntries(ACCENT_IDS.map((id) => [ACCENTS[id], id])) as Record<string, AccentId>;

export type NamedAccent = { readonly kind: "named"; readonly id: AccentId };
export type CustomAccent = { readonly kind: "custom"; readonly fill: Fill };
export type Accent = NamedAccent | CustomAccent;
export const DEFAULT_ACCENT: NamedAccent = { kind: "named", id: "blue500" };

export type Prefs = {
	readonly look: Look | null;
	readonly accent: Accent;
};

export function fillOfAccent(a: Accent): Fill {
	return a.kind === "named" ? ACCENTS[a.id] : a.fill;
}

export function themeColorOf(a: Accent): AccentId {
	return a.kind === "named" ? a.id : "blue500";
}

export function accentWire(a: Accent): string | Gradient {
	if (a.kind === "named") return a.id;
	return a.fill;
}

export function parseAccent(v: unknown): Accent | null {
	if (typeof v === "string" && ACCENT_ID_SET.has(v)) return { kind: "named", id: v as AccentId };
	const fill = parseFill(v);
	if (!fill) return null;
	if (typeof fill === "string") {
		const id = HEX_TO_ACCENT[fill];
		return id ? { kind: "named", id } : { kind: "custom", fill };
	}
	if (fill.stops.length === 1) {
		const id = HEX_TO_ACCENT[fill.stops[0]!];
		if (id) return { kind: "named", id };
		return { kind: "custom", fill: fill.stops[0]! };
	}
	return { kind: "custom", fill };
}

export function overlayAccent(look: Look | null, accent: Accent): Look | null {
	if (!look || look.kind !== "painted") return look;
	return { kind: "painted", theme: { ...look.theme, accent: fillOfAccent(accent) } };
}

export const PRESET_NAMES: Record<string, string> = {
	dim: "Dim",
	midnight: "Midnight",
	sunset: "Sunset",
	ember: "Ember",
	ocean: "Ocean",
	forest: "Forest",
	rose: "Rosé",
	mono: "Mono",
};

const t = (
	id: string,
	base: "dark" | "light",
	bg: string[],
	angle: number,
	surface: string,
	text: string,
	accent: string,
	button: string[],
	buttonAngle: number,
	buttonText: string,
	extra: Partial<Theme> = {},
): Theme => ({
	id,
	base,
	bg: { stops: bg, angle },
	surface,
	text,
	accent,
	button: { stops: button, angle: buttonAngle },
	buttonText,
	...extra,
});

export const PRESETS: Record<string, Theme> = {
	dim: t("dim", "dark", ["#15202b"], 180, "#1e2732", "#f7f9f9", "#1d9bf0", ["#eff3f4"], 180, "#0f1419", {
		muted: "#8b98a5",
		border: "#38444d",
		inputBg: "#253341",
		inputBorder: "#425364",
	}),
	midnight: t("midnight", "dark", ["#070b1a", "#2a1060"], 135, "#12162c", "#f2f0ff", "#8b7cff", ["#eef0ff"], 135, "#070b1a"),
	sunset: t("sunset", "dark", ["#2a0c08", "#6a1838", "#241040"], 120, "#2a121c", "#fff4ea", "#ff8a4c", ["#fff4ea"], 120, "#2a0c08"),
	ember: t("ember", "dark", ["#1a0b06", "#4a1608"], 140, "#2b120c", "#fff6ee", "#ffb020", ["#fff6ee"], 140, "#1a0b06", {
		link: "#ffb020",
		muted: "#c9a090",
		reply: "#ffb020",
		bookmark: "#ffb020",
	}),
	ocean: t("ocean", "dark", ["#032830", "#0a1c48"], 160, "#0c2430", "#e9f8fa", "#3ecfcf", ["#e9f8fa"], 160, "#032830"),
	forest: t("forest", "dark", ["#0e1c14", "#163024"], 180, "#16261c", "#e7f2ea", "#3dd68c", ["#e7f2ea"], 180, "#0e1c14"),
	rose: t("rose", "light", ["#fceef3", "#f7e0e8"], 160, "#fff7fa", "#3a1524", "#a83262", ["#3a1524"], 160, "#fff7fa"),
	mono: t("mono", "dark", ["#1b1d20"], 180, "#26282c", "#e8e9eb", "#a8adb4", ["#e8e9eb"], 180, "#1b1d20"),
};

export const SWATCH_IDS = ["midnight", "sunset", "ember", "ocean", "forest", "rose", "mono"] as const;

export function fillCss(g: Fill): string {
	if (typeof g === "string") return g;
	return g.stops.length === 1 ? g.stops[0]! : `linear-gradient(${g.angle}deg,${g.stops.join(",")})`;
}

function rgba(h: string, a: number): string {
	const [r, g, b] = rgb(h);
	return `rgba(${r}, ${g}, ${b}, ${a})`;
}

function alphaBg(h: string, a: number): string {
	const [r, g, b] = rgb(h);
	return `rgb(${r} ${g} ${b} / ${a})`;
}

export type Resolved = {
	bg: string;
	surface: string;
	text: string;
	accent: string;
	accentFill: string;
	button: string;
	buttonText: string;
	link: string;
	secondary: string;
	muted: string;
	border: string;
	divider: string;
	hover: string;
	inputBg: string;
	inputText: string;
	inputBorder: string;
	header: string;
	menu: string;
	tooltip: string;
	icon: string;
	iconActive: string;
	reply: string;
	repost: string;
	like: string;
	bookmark: string;
	views: string;
	secondaryButton: string;
	secondaryButtonBorder: string;
	secondaryButtonText: string;
	buttonHover: string;
	badge: string;
	selection: string;
	accentSoft: string;
	replySoft: string;
	repostSoft: string;
	likeSoft: string;
	bookmarkSoft: string;
};

export function derived(theme: Theme): Resolved {
	const avg = averageHex(theme.bg.stops);
	const surface = solidOf(theme.surface);
	const text = theme.text;
	const muted = theme.muted ?? mixHex(text, avg, 0.45);
	const border = theme.border ?? mixHex(text, avg, 0.82);
	const accentSolid = solidOf(theme.accent);
	const reply = theme.reply ?? accentSolid;
	const bookmark = theme.bookmark ?? accentSolid;
	const like = theme.like ?? LIKE;
	const repost = theme.repost ?? REPOST;
	const tr = rgb(text);
	return {
		bg: fillCss(theme.bg),
		surface: fillCss(theme.surface),
		text,
		accent: accentSolid,
		accentFill: fillCss(theme.accent),
		button: fillCss(theme.button),
		buttonText: theme.buttonText,
		link: theme.link ?? accentSolid,
		secondary: theme.secondary ?? mixHex(text, avg, 0.28),
		muted,
		border,
		divider: theme.divider ?? border,
		hover: theme.hover ?? `rgb(${tr[0]} ${tr[1]} ${tr[2]} / .1)`,
		inputBg: theme.inputBg ?? mixHex(surface, text, 0.08),
		inputText: theme.inputText ?? text,
		inputBorder: theme.inputBorder ?? border,
		header: theme.header ? fillCss(theme.header) : alphaBg(avg, 0.85),
		menu: theme.menu ? fillCss(theme.menu) : fillCss(theme.surface),
		tooltip: theme.tooltip ?? mixHex(surface, text, 0.16),
		icon: theme.icon ?? muted,
		iconActive: theme.iconActive ?? text,
		reply,
		repost,
		like,
		bookmark,
		views: theme.views ?? muted,
		secondaryButton: theme.secondaryButton ? fillCss(theme.secondaryButton) : "transparent",
		secondaryButtonBorder: theme.secondaryButtonBorder ?? border,
		secondaryButtonText: theme.secondaryButtonText ?? text,
		buttonHover: theme.buttonHover ?? mixHex(solidOf(theme.button), text, 0.12),
		badge: theme.badge ?? accentSolid,
		selection: theme.selection ?? rgba(accentSolid, 0.28),
		accentSoft: rgba(accentSolid, 0.1),
		replySoft: rgba(reply, 0.1),
		repostSoft: rgba(repost, 0.1),
		likeSoft: rgba(like, 0.1),
		bookmarkSoft: rgba(bookmark, 0.1),
	};
}

export type AccountTokens = {
	bg: string;
	bar: string;
	text: string;
	muted: string;
	border: string;
	field: string;
	outline: string;
	surface: string;
	hover: string;
	logo: string;
	scheme: string;
	accent: string;
	accentHover: string;
	font?: string;
};

export function deriveTokens(theme: Theme): AccountTokens {
	const d = derived(theme);
	const accentHover = mixHex(d.accent, INK, 0.12);
	return {
		bg: d.bg,
		bar: d.header,
		text: d.text,
		muted: d.muted,
		border: d.border,
		field: d.inputBorder,
		outline: d.secondaryButtonBorder,
		surface: solidOf(theme.surface),
		hover: d.hover,
		logo: theme.base === "light" ? "url(/public/logo-light.png)" : "url(/public/logo-dark.png)",
		scheme: theme.base,
		accent: d.accent,
		accentHover,
		font: theme.font?.ui ? `"${theme.font.ui}",${CHIRP}` : undefined,
	};
}

export function xtVars(theme: Theme): Record<string, string> {
	const d = derived(theme);
	return {
		"--xt-bg": d.bg,
		"--xt-surface": d.surface,
		"--xt-text": d.text,
		"--xt-secondary": d.secondary,
		"--xt-muted": d.muted,
		"--xt-link": d.link,
		"--xt-border": d.border,
		"--xt-divider": d.divider,
		"--xt-accent": d.accent,
		"--xt-accent-fill": d.accentFill,
		"--xt-button": d.button,
		"--xt-button-text": d.buttonText,
		"--xt-button-hover": d.buttonHover,
		"--xt-header": d.header,
		"--xt-hover": d.hover,
		"--xt-input": d.inputBg,
		"--xt-input-text": d.inputText,
		"--xt-input-border": d.inputBorder,
		"--xt-menu": d.menu,
		"--xt-tooltip": d.tooltip,
		"--xt-icon": d.icon,
		"--xt-icon-active": d.iconActive,
		"--xt-reply": d.reply,
		"--xt-repost": d.repost,
		"--xt-like": d.like,
		"--xt-bookmark": d.bookmark,
		"--xt-views": d.views,
		"--xt-secondary-button": d.secondaryButton,
		"--xt-secondary-button-border": d.secondaryButtonBorder,
		"--xt-secondary-button-text": d.secondaryButtonText,
		"--xt-badge": d.badge,
		"--xt-selection": d.selection,
		"--xt-accent-soft": d.accentSoft,
		"--xt-reply-soft": d.replySoft,
		"--xt-repost-soft": d.repostSoft,
		"--xt-like-soft": d.likeSoft,
		"--xt-bookmark-soft": d.bookmarkSoft,
	};
}

export function accentVars(accent: Accent): string {
	const fill = fillOfAccent(accent);
	const solid = solidOf(fill);
	const hover = mixHex(solid, INK, 0.12);
	return `--xt-accent:${solid};--xt-accent-fill:${fillCss(fill)};--xt-accent-soft:${rgba(solid, 0.1)};--xt-accent-hover:${hover};--accent:${solid};--accent-fill:${fillCss(fill)};--accent-hover:${hover};--accent-text:${readableOn([solid])}`;
}

export function accountVars(theme: Theme): string {
	const tkn = deriveTokens(theme);
	const d = derived(theme);
	const rows: Record<string, string> = {
		bg: tkn.bg,
		bar: tkn.bar,
		text: tkn.text,
		muted: tkn.muted,
		border: tkn.border,
		field: tkn.field,
		outline: tkn.outline,
		surface: tkn.surface,
		hover: tkn.hover,
		logo: tkn.logo,
		accent: tkn.accent,
		"accent-fill": d.accentFill,
		"accent-hover": tkn.accentHover,
		"accent-text": /^#[0-9a-f]{6}$/i.test(tkn.accent) ? readableOn([tkn.accent]) : WHITE,
	};
	if (tkn.font) rows.font = tkn.font;
	return Object.entries(rows)
		.map(([k, v]) => `--${k}:${v}`)
		.join(";") + `;color-scheme:${tkn.scheme}`;
}

function fontFamilyCss(theme: Theme): string {
	let css = "";
	if (theme.font?.ui) css += `html[data-xitter-theme] body,html[data-xitter-theme] .css-146c3p1,html[data-xitter-theme] .css-1jxf684{font-family:"${theme.font.ui}",${CHIRP}!important}`;
	if (theme.font?.display)
		css += `html[data-xitter-theme] [data-testid="User-Name"] span:first-of-type,html[data-xitter-theme] [data-testid="UserName"],html[data-xitter-theme] h1,html[data-xitter-theme] h2{font-family:"${theme.font.display}",${CHIRP}!important}`;
	return css;
}

const PAGE_GATE = "html[data-xitter-theme]:not([data-xitter-decor])";
const FIT_CSS: Record<BgFit, string> = { cover: "cover", contain: "contain", tile: "auto" };
const POSITION_CSS: Record<BgPosition, string> = { center: "center", top: "top", bottom: "bottom" };

function cssUrl(path: string): string {
	if (!/^\/media\/(?:poster\/)?\d{1,19}\.(?:png|gif|webp|jpg)$/.test(path)) return "none";
	return `url("${path}")`;
}

export function pageChromeCss(paint?: BackgroundPaint): string {
	if (!paint) return "";
	const repeat = paint.fit === "tile" ? "repeat" : "no-repeat";
	const still = paint.still ? cssUrl(paint.still) : cssUrl(paint.image);
	return (
		`html[data-xitter-theme]{--xt-bg-image:${cssUrl(paint.image)};--xt-bg-still:${still};--xt-bg-size:${FIT_CSS[paint.fit]};--xt-bg-position:${POSITION_CSS[paint.position]};--xt-bg-repeat:${repeat};--xt-bg-dim:${paint.dim / 100};--xt-bg-blur:${paint.blur}px}` +
		`${PAGE_GATE} body{position:relative;z-index:0}` +
		`${PAGE_GATE} body::before{content:"";position:fixed;inset:0;z-index:-1;background-image:var(--xt-bg-image);background-size:var(--xt-bg-size);background-position:var(--xt-bg-position);background-repeat:var(--xt-bg-repeat);filter:blur(var(--xt-bg-blur));pointer-events:none}` +
		`${PAGE_GATE} body::after{content:"";position:fixed;inset:0;z-index:-1;background:rgb(0 0 0 / var(--xt-bg-dim));pointer-events:none}` +
		`@media (prefers-reduced-motion:reduce){${PAGE_GATE} body::before{animation:none;background-image:var(--xt-bg-still)}}`
	);
}

export function bootCss(theme: Theme, paint?: BackgroundPaint): string {
	const vars = Object.entries(xtVars(theme))
		.map(([k, v]) => `${k}:${v}`)
		.join(";");
	return (
		`html[data-xitter-theme]{${vars}}` +
		`html[data-xitter-theme] ::selection{background:var(--xt-selection)}` +
		`${PAGE_GATE},${PAGE_GATE} body{background:var(--xt-bg)!important;background-attachment:fixed!important}` +
		`${PAGE_GATE} #react-root>div>div,${PAGE_GATE} #react-root>div>div>div:not([data-testid]){background-color:transparent!important}` +
		pageChromeCss(paint) +
		fontFamilyCss(theme)
	);
}

export async function resolveBackground(userId: string, theme: Theme): Promise<BackgroundPaint | undefined> {
	const bg = theme.background;
	if (!bg?.mediaId) return;
	const { ownedThemePhoto, themeMediaPath, themePosterPath } = await import("./media");
	const photo = await ownedThemePhoto(userId, bg.mediaId);
	if (!photo) return;
	return {
		image: themeMediaPath(bg.mediaId, photo.ext),
		still: photo.poster ? themePosterPath(bg.mediaId) : null,
		fit: bg.fit,
		position: bg.position,
		dim: bg.dim,
		blur: bg.blur,
	};
}

export function bootAccentCss(accent: Accent): string {
	return `html{${accentVars(accent)}}`;
}

export function fontLinks(theme: Theme | null): string {
	if (!theme?.font) return "";
	const names = [theme.font.ui, theme.font.display].filter((n, i, a): n is string => !!n && a.indexOf(n) === i);
	return names.map((n) => `<link rel="stylesheet" href="/i/xitter/fonts/${fontSlug(n)}/fonts.css">`).join("");
}

function warnPairs(label: string, fg: string, bgs: string[], min = 4.5): string[] {
	const out: string[] = [];
	for (const bg of bgs) {
		const c = contrast(fg, bg);
		if (c < min) out.push(`${label} on ${bg} is ${c.toFixed(2)}:1`);
	}
	return out;
}

function clampFg(fg: string, bgs: string[]): string {
	if (!bgs.length || Math.min(...bgs.map((bg) => contrast(fg, bg))) >= 3) return fg;
	return readableOn(bgs);
}

const asMediaId = (v: string): MediaId => v as MediaId;
const asDim = (n: number): Dim => n as Dim;
const asBlur = (n: number): BlurPx => n as BlurPx;

function pushError(errors: ThemeError[], path: string, message: string) {
	errors.push({ path, message });
}

function isBanned(key: string): boolean {
	return (BANNED_KEYS as readonly string[]).includes(key);
}

function isForbiddenImport(key: string): boolean {
	return (IMPORT_FORBIDDEN as readonly string[]).includes(key);
}

function checkShape(value: unknown, depth: number, path: string, mode: ThemeMode, errors: ThemeError[]) {
	if (Array.isArray(value)) {
		if (value.length > ARRAY_CAP) pushError(errors, path, "too many items");
		const n = Math.min(value.length, ARRAY_CAP + 1);
		for (let i = 0; i < n; i++) {
			const child = `${path}[${i}]`;
			if (depth + 1 > THEME_DEPTH_MAX) {
				pushError(errors, child, "too deeply nested");
				continue;
			}
			checkShape(value[i], depth + 1, child, mode, errors);
		}
		return;
	}
	if (!value || typeof value !== "object") return;
	if (depth > THEME_DEPTH_MAX) {
		pushError(errors, path, "too deeply nested");
		return;
	}
	const keys = Object.keys(value);
	if (keys.length > KEY_CAP) pushError(errors, path, "too many keys");
	for (const key of keys) {
		const childPath = path ? `${path}.${key}` : key;
		if (isBanned(key)) {
			if (mode !== "read") pushError(errors, childPath, "banned key");
			if (mode === "read") continue;
		} else if (mode === "import" && isForbiddenImport(key)) pushError(errors, childPath, "forbidden key");
		const child = (value as Record<string, unknown>)[key];
		if (depth + 1 > THEME_DEPTH_MAX && child && typeof child === "object") {
			pushError(errors, childPath, "too deeply nested");
			continue;
		}
		checkShape(child, depth + 1, childPath, mode, errors);
	}
}

function hexOfMode(v: unknown, mode: ThemeMode): string | undefined {
	if (typeof v !== "string") return;
	const s = v.trim().toLowerCase();
	const m6 = HEX6.exec(s);
	if (m6) return `#${m6[1]}`;
	if (mode === "import") return;
	const m3 = HEX3.exec(s);
	if (m3) return `#${m3[1]}${m3[1]}${m3[2]}${m3[2]}${m3[3]}${m3[3]}`;
}

function angleOfMode(v: unknown, mode: ThemeMode): number | undefined {
	if (mode === "import") {
		if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 360) return;
		return v;
	}
	return intAngle(v);
}

function ownUnknown(value: object, allowed: readonly string[], path: string, mode: ThemeMode, errors: ThemeError[]) {
	if (mode === "read") return;
	for (const key of Object.keys(value)) {
		if (allowed.includes(key) || isBanned(key) || (mode === "import" && isForbiddenImport(key))) continue;
		pushError(errors, path ? `${path}.${key}` : key, "unknown key");
	}
}

function gradientOf(v: unknown, mode: ThemeMode, path: string, errors: ThemeError[], bareHex: boolean): Gradient | undefined {
	if (bareHex && mode !== "import") {
		const h = hexOfMode(v, mode);
		if (h) return { stops: [h], angle: 180 };
	}
	if (!v || typeof v !== "object" || Array.isArray(v)) return;
	const g = v as Record<string, unknown>;
	ownUnknown(g, ["stops", "angle"], path, mode, errors);
	const min = mode === "import" ? 2 : 1;
	if (!Array.isArray(g.stops) || g.stops.length < min || g.stops.length > 5) return;
	const stops = g.stops.map((stop) => hexOfMode(stop, mode));
	if (stops.some((s) => !s)) return;
	const angle = angleOfMode(g.angle, mode);
	if (angle === undefined) return;
	return { stops: stops as string[], angle };
}

function fillOfMode(v: unknown, mode: ThemeMode, path: string, errors: ThemeError[]): Fill | undefined {
	const h = hexOfMode(v, mode);
	if (h) return h;
	return gradientOf(v, mode, path, errors, false);
}

function copyTheme(theme: Theme): Theme {
	const out = {} as Theme;
	for (const field of THEME_FIELDS) {
		const value = theme[field.key];
		if (value !== undefined) (out as Record<string, unknown>)[field.key] = value;
	}
	return out;
}

function parseTheme(input: unknown, mode: ThemeMode): ParsedTheme {
	const errors: ThemeError[] = [];
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		return { ok: false, errors: [{ path: "", message: "theme must be an object" }] };
	}
	checkShape(input, 1, "", mode, errors);
	const o = input as Record<string, unknown>;
	const known = new Set<string>(THEME_FIELDS.map((f) => f.key));
	for (const key of Object.keys(o)) {
		if (isBanned(key)) continue;
		if (mode === "import" && isForbiddenImport(key)) continue;
		if (!known.has(key) && mode !== "read") pushError(errors, key, "unknown key");
	}
	const preset = typeof o.id === "string" ? PRESETS[o.id] : undefined;
	const idKnown = typeof o.id === "string" && (o.id === "custom" || !!PRESETS[o.id]);
	let id: string | undefined;
	if (idKnown) id = o.id as string;
	else if (mode === "import") pushError(errors, "id", "unknown theme");
	else id = "custom";
	const basePresent = "base" in o;
	let base: "light" | "dark" | undefined;
	if (o.base === "light" || o.base === "dark") base = o.base;
	else if (mode === "import" && basePresent) pushError(errors, "base", "invalid base");
	else base = preset?.base;
	if (base !== "light" && base !== "dark" && !(mode === "import" && basePresent)) pushError(errors, "base", "invalid base");

	const takeRequired = <T>(key: string, present: boolean, parsed: T | undefined, fallback: T | undefined, message: string): T | undefined => {
		if (parsed) return parsed;
		if (present && mode === "import") {
			pushError(errors, key, message);
			return;
		}
		if (fallback !== undefined && mode !== "import") return fallback;
		if (fallback !== undefined && !present) return fallback;
		pushError(errors, key, present ? message : "missing");
		return;
	};

	const bg = takeRequired("bg", "bg" in o, gradientOf(o.bg, mode, "bg", errors, true), preset?.bg, "invalid colour");
	const button = takeRequired("button", "button" in o, gradientOf(o.button, mode, "button", errors, true), preset?.button, "invalid colour");
	const surface = takeRequired("surface", "surface" in o, "surface" in o ? fillOfMode(o.surface, mode, "surface", errors) : undefined, preset?.surface, "invalid colour");
	let text = takeRequired("text", "text" in o, hexOfMode(o.text, mode), preset?.text, "invalid colour");
	const accent = takeRequired("accent", "accent" in o, "accent" in o ? fillOfMode(o.accent, mode, "accent", errors) : undefined, preset?.accent, "invalid colour");
	let buttonText = takeRequired("buttonText", "buttonText" in o, hexOfMode(o.buttonText, mode), preset?.buttonText, "invalid colour");

	const theme = {} as Theme;
	if (id) theme.id = id;
	if (base === "light" || base === "dark") theme.base = base;
	if (bg) theme.bg = bg;
	if (surface) theme.surface = surface;
	if (text) theme.text = text;
	if (accent) theme.accent = accent;
	if (button) theme.button = button;
	if (buttonText) theme.buttonText = buttonText;

	for (const field of THEME_FIELDS) {
		if (field.required || (field.kind !== "hex" && field.kind !== "fill")) continue;
		const key = field.key;
		if (!(key in o)) {
			const fallback = preset?.[key];
			if (fallback !== undefined) (theme as Record<string, unknown>)[key] = fallback;
			continue;
		}
		const parsed = field.kind === "hex" ? hexOfMode(o[key], mode) : fillOfMode(o[key], mode, key, errors);
		if (parsed) (theme as Record<string, unknown>)[key] = parsed;
		else if (mode === "import") pushError(errors, key, "invalid colour");
	}

	if ("font" in o) {
		const fontValue = o.font;
		if (!fontValue || typeof fontValue !== "object" || Array.isArray(fontValue)) {
			if (mode !== "read") pushError(errors, "font", "invalid font");
		} else {
			const fontObj = fontValue as Record<string, unknown>;
			ownUnknown(fontObj, FONT_KEYS, "font", mode, errors);
			const font: ThemeFont = {};
			for (const key of FONT_KEYS) {
				if (!(key in fontObj)) continue;
				const name = validateFamily(fontObj[key]);
				if (name) font[key] = name;
				else if (mode === "import") pushError(errors, `font.${key}`, "invalid font");
			}
			if (font.ui || font.display) theme.font = font;
		}
	} else if (preset?.font) theme.font = preset.font;

	if ("background" in o) {
		const raw = o.background;
		if (raw === null && mode === "save") {
			/* clear is applied by the save peel */
		} else if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
			if (mode !== "read") pushError(errors, "background", "invalid background");
		} else {
			const bgObj = raw as Record<string, unknown>;
			ownUnknown(bgObj, BACKGROUND_FIELDS.map((f) => f.key), "background", mode, errors);
			const background = {} as ThemeBackground;
			const fit = "fit" in bgObj ? bgObj.fit : "cover";
			const position = "position" in bgObj ? bgObj.position : "center";
			const dim = "dim" in bgObj ? bgObj.dim : 0;
			const blur = "blur" in bgObj ? bgObj.blur : 0;
			if ((FITS as readonly string[]).includes(fit as string)) background.fit = fit as BgFit;
			else if (mode === "read") background.fit = "cover";
			else pushError(errors, "background.fit", "invalid fit");
			if ((POSITIONS as readonly string[]).includes(position as string)) background.position = position as BgPosition;
			else if (mode === "read") background.position = "center";
			else pushError(errors, "background.position", "invalid position");
			const dimN = typeof dim === "number" && Number.isInteger(dim) && dim >= 0 && dim <= 80 ? dim : undefined;
			const blurN = typeof blur === "number" && Number.isInteger(blur) && blur >= 0 && blur <= 20 ? blur : undefined;
			if (dimN !== undefined) background.dim = asDim(dimN);
			else if (mode === "read") background.dim = asDim(0);
			else pushError(errors, "background.dim", "invalid dim");
			if (blurN !== undefined) background.blur = asBlur(blurN);
			else if (mode === "read") background.blur = asBlur(0);
			else pushError(errors, "background.blur", "invalid blur");
			if ("mediaId" in bgObj) {
				if (mode === "import") pushError(errors, "background.mediaId", "forbidden key");
				else if (isId(bgObj.mediaId)) background.mediaId = asMediaId(bgObj.mediaId);
				else if (mode === "save") pushError(errors, "background.mediaId", "invalid media id");
			}
			if (background.fit && background.position && background.dim !== undefined && background.blur !== undefined && !errors.some((e) => e.path.startsWith("background")))
				theme.background = background;
		}
	}

	if (!theme.id || !theme.base || !theme.bg || !theme.surface || !theme.text || !theme.accent || !theme.button || !theme.buttonText) {
		if (!errors.length) pushError(errors, "", "theme must be an object");
		return { ok: false, errors };
	}
	if (errors.length) return { ok: false, errors };

	const d = derived(theme);
	const pageBgs = [...theme.bg.stops, ...stopsOf(theme.surface)];
	const warnings = [...warnPairs("text", text!, pageBgs), ...warnPairs("button text", buttonText!, theme.button.stops)];
	text = clampFg(text!, pageBgs);
	buttonText = clampFg(buttonText!, theme.button.stops);
	theme.text = text;
	theme.buttonText = buttonText;
	const clampOpt = (key: keyof Theme, fg: string | undefined, bgs: string[], label: string, warnAt: number) => {
		if (!fg) return;
		warnings.push(...warnPairs(label, fg, bgs, warnAt));
		(theme as Record<string, unknown>)[key] = clampFg(fg, bgs);
	};
	clampOpt("secondary", theme.secondary, pageBgs, "secondary text", 4.5);
	clampOpt("muted", theme.muted, pageBgs, "muted text", 3);
	clampOpt("link", theme.link, pageBgs, "link", 4.5);
	clampOpt("inputText", theme.inputText, [theme.inputBg ?? d.inputBg], "input text", 4.5);
	clampOpt("secondaryButtonText", theme.secondaryButtonText, theme.secondaryButton ? stopsOf(theme.secondaryButton) : pageBgs, "secondary button text", 4.5);
	return { ok: true, theme, warnings };
}

export function sanitiseTheme(input: unknown): Sanitised | null {
	const got = parseTheme(input, "read");
	if (!got.ok) return null;
	return { theme: got.theme, warnings: [...got.warnings] };
}

function freshCopy(value: unknown): unknown {
	if (Array.isArray(value)) return value.map((item) => freshCopy(item));
	if (!value || typeof value !== "object") return value;
	const out = Object.create(null) as Record<string, unknown>;
	for (const key of Object.keys(value)) {
		Object.defineProperty(out, key, { value: freshCopy((value as Record<string, unknown>)[key]), enumerable: true, writable: true, configurable: true });
	}
	return out;
}

export function importTheme(text: string): ImportResult {
	if (Buffer.byteLength(text) > THEME_FILE_MAX) return { ok: false, errors: [{ path: "", message: "file is too large" }] };
	let parsed: unknown;
	try {
		parsed = JSON.parse(text, (key, value) => {
			if (key === "__proto__" || key === "constructor" || key === "prototype") throw new Error("banned");
			return value;
		});
	} catch (err) {
		if (err instanceof Error && err.message === "banned") return { ok: false, errors: [{ path: "", message: "banned key" }] };
		return { ok: false, errors: [{ path: "", message: "invalid json" }] };
	}
	const errors: ThemeError[] = [];
	const root = freshCopy(parsed);
	checkShape(root, 1, "", "import", errors);
	if (!root || typeof root !== "object" || Array.isArray(root)) return { ok: false, errors: [{ path: "", message: "invalid file" }] };
	const envelope = root as Record<string, unknown>;
	for (const key of Object.keys(envelope)) {
		if (isBanned(key)) continue;
		if (key !== "format" && key !== "version" && key !== "theme") pushError(errors, key, "unknown key");
	}
	if (envelope.format !== THEME_FORMAT) pushError(errors, "format", "unknown format");
	if (envelope.version !== THEME_VERSION) pushError(errors, "version", "unknown version");
	if (errors.length) return { ok: false, errors };
	const got = parseTheme(envelope.theme, "import");
	if (!got.ok) return { ok: false, errors: got.errors.map((e) => ({ path: e.path ? `theme.${e.path}` : "theme", message: e.message })) };
	const warnings = [...got.warnings];
	if (got.theme.background) warnings.push(BACKGROUND_OMITTED);
	const theme = copyTheme(got.theme) as ImportedTheme;
	if (theme.background) {
		const { fit, position, dim, blur } = theme.background;
		theme.background = { fit, position, dim, blur };
	}
	return { ok: true, theme, warnings };
}

function shareFill(value: Fill): Fill {
	if (typeof value === "string") return value;
	const stops = value.stops.length === 1 ? [value.stops[0]!, value.stops[0]!] : [...value.stops];
	return { stops, angle: value.angle };
}

export function exportTheme(theme: Theme): ThemeFile {
	const shared = Object.create(null) as SharedTheme;
	for (const field of THEME_FIELDS) {
		if (!field.share) continue;
		const value = theme[field.key];
		if (value === undefined) continue;
		if (field.kind === "gradient") {
			shared[field.key] = shareFill(value as Gradient) as never;
			continue;
		}
		if (field.kind === "fill") {
			shared[field.key] = shareFill(value as Fill) as never;
			continue;
		}
		if (field.kind === "background") {
			const bg = value as ThemeBackground;
			shared.background = { fit: bg.fit, position: bg.position, dim: bg.dim, blur: bg.blur };
			continue;
		}
		(shared as Record<string, unknown>)[field.key] = value;
	}
	return { format: THEME_FORMAT, version: THEME_VERSION, theme: shared };
}

export function themeFileName(theme: Theme): `${string}.xitter-theme.json` {
	const id = theme.id === "custom" || PRESETS[theme.id] ? theme.id : "custom";
	return `${id}.xitter-theme.json`;
}

export async function themeImport(req: Request, _viewer: Viewer): Promise<Response> {
	if (req.method !== "POST") return Response.json({ ok: false, errors: [{ path: "", message: "use POST" }] }, { status: 405 });
	const announced = Number(req.headers.get("content-length"));
	if (Number.isFinite(announced) && announced > THEME_FILE_MAX) return Response.json({ ok: false, errors: [{ path: "", message: "file is too large" }] }, { status: 400 });
	const result = importTheme(await req.text());
	if (!result.ok) return Response.json({ ok: false, errors: result.errors }, { status: 400 });
	return Response.json({ ok: true, theme: result.theme, warnings: result.warnings });
}

export async function themeExport(req: Request, viewer: Viewer): Promise<Response> {
	if (req.method !== "GET") return Response.json({ ok: false, errors: [{ path: "", message: "use GET" }] }, { status: 405 });
	const prefs = await loadPrefs(viewer.id);
	const theme = prefs.look?.kind === "painted" ? prefs.look.theme : null;
	if (!theme) return Response.json({ ok: false, errors: [{ path: "theme", message: "no saved theme" }] }, { status: 404 });
	const file = exportTheme(theme);
	return new Response(JSON.stringify(file), {
		headers: {
			"content-type": "application/json; charset=utf-8",
			"content-disposition": `attachment; filename="${themeFileName(theme)}"`,
		},
	});
}

export function mergeSavedBackground(previous: Theme | undefined, theme: Theme, peel: "keep" | "clear" | "frame", mediaIdSent: boolean): Theme {
	if (peel === "keep") {
		if (!previous?.background) return theme;
		const next = copyTheme(theme);
		next.background = previous.background;
		return next;
	}
	if (peel === "clear") {
		const next = copyTheme(theme);
		delete next.background;
		return next;
	}
	if (theme.background && !mediaIdSent && previous?.background?.mediaId) {
		const next = copyTheme(theme);
		next.background = {
			fit: theme.background.fit,
			position: theme.background.position,
			dim: theme.background.dim,
			blur: theme.background.blur,
			mediaId: previous.background.mediaId,
		};
		return next;
	}
	return theme;
}

export function swatches(): { id: string; name: string; bg: Gradient; base: "dark" | "light" }[] {
	return SWATCH_IDS.map((id) => {
		const p = PRESETS[id]!;
		return { id, name: PRESET_NAMES[id]!, bg: p.bg, base: p.base };
	});
}

export type Mode = "light" | "dark";

export type NativeLook = {
	readonly kind: "native";
	readonly mode: Mode;
};

export type PaintedLook = {
	readonly kind: "painted";
	readonly theme: Theme;
};

export type Look = NativeLook | PaintedLook;

export type LookView = {
	readonly mode: Mode | null;
	readonly theme: Theme | null;
	readonly accent: string | Gradient;
};

export type ClientLook = {
	readonly night: "0" | "2";
	readonly theme: Theme | null;
	readonly accent: string | Gradient;
	readonly themeColor: AccentId;
};

export type LookWrite =
	| { readonly type: "plain"; readonly mode: Mode }
	| { readonly type: "clear" }
	| { readonly type: "paint"; readonly theme: Theme; readonly peel: "keep" | "clear" | "frame"; readonly mediaIdSent: boolean }
	| { readonly type: "keep" };

export type ParsedWrite =
	| { readonly ok: true; readonly write: LookWrite; readonly accent?: Accent; readonly warnings: readonly string[] }
	| { readonly ok: false; readonly error: string; readonly errors?: readonly ThemeError[] };

export type AccountPalette = "light" | "dim" | "dark";

export const NIGHT_MODE_ATTR = "Path=/; Max-Age=31536000; SameSite=Lax";

export const LINK_SCOPES = [
	'[data-testid="tweetText"]',
	'[data-testid="UserMention"]',
	'a[href*="/hashtag/"]',
	'[data-testid^="card.layout"]',
] as const;

export function modeOf(look: Look): Mode {
	return look.kind === "native" ? look.mode : look.theme.base;
}

export function readAccent(preferences: unknown, look: Look | null): Accent {
	const row = preferences && typeof preferences === "object" && !Array.isArray(preferences) ? (preferences as Record<string, unknown>) : null;
	const fromPref = row && "accent" in row ? parseAccent(row.accent) : null;
	if (fromPref) return fromPref;
	if (look?.kind === "painted") return parseAccent(look.theme.accent) ?? DEFAULT_ACCENT;
	return DEFAULT_ACCENT;
}

export function readPrefs(preferences: unknown): Prefs {
	const look = readLookRaw(preferences);
	const accent = readAccent(preferences, look);
	return { look: overlayAccent(look, accent), accent };
}

function readLookRaw(preferences: unknown): Look | null {
	if (!preferences || typeof preferences !== "object" || Array.isArray(preferences)) return null;
	const row = preferences as Record<string, unknown>;
	const theme = sanitiseTheme(row.theme)?.theme;
	if (theme) return { kind: "painted", theme };
	if (row.mode === "light" || row.mode === "dark") return { kind: "native", mode: row.mode };
	return null;
}

export function readLook(preferences: unknown): Look | null {
	return readPrefs(preferences).look;
}

function accentFromBody(o: Record<string, unknown>): { accent?: Accent; error?: string } {
	if (!("accent" in o)) return {};
	if (o.accent === null) return { accent: DEFAULT_ACCENT };
	const accent = parseAccent(o.accent);
	if (!accent) return { error: "that isn't an accent" };
	return { accent };
}

export function parseLookWrite(body: unknown): ParsedWrite {
	if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "that isn't a theme" };
	const o = body as Record<string, unknown>;
	const mode = o.mode === "light" || o.mode === "dark" ? o.mode : undefined;
	const hasMode = "mode" in o;
	const gotAccent = accentFromBody(o);
	if (gotAccent.error) return { ok: false, error: gotAccent.error };
	const extra = gotAccent.accent ? { accent: gotAccent.accent } : {};
	if (o.clear === true) {
		if (hasMode) return { ok: false, error: "invalid mode" };
		return { ok: true, write: { type: "clear" }, warnings: [], ...extra };
	}
	if (o.theme && typeof o.theme === "object" && !Array.isArray(o.theme)) {
		const themeBody = o.theme as Record<string, unknown>;
		const got = parseTheme(themeBody, "save");
		if (!got.ok) return { ok: false, error: "that isn't a theme", errors: got.errors };
		if (hasMode && mode !== got.theme.base) return { ok: false, error: "invalid mode" };
		const fromTheme = "accent" in themeBody ? parseAccent(themeBody.accent) ?? parseAccent(got.theme.accent) : undefined;
		const peel = !("background" in themeBody) ? "keep" : themeBody.background === null ? "clear" : "frame";
		const mediaIdSent = peel === "frame" && !!themeBody.background && typeof themeBody.background === "object" && "mediaId" in themeBody.background;
		return { ok: true, write: { type: "paint", theme: got.theme, peel, mediaIdSent }, warnings: got.warnings, accent: extra.accent ?? fromTheme };
	}
	if (hasMode) {
		if (!mode) return { ok: false, error: "invalid mode" };
		if ("theme" in o && o.theme !== null) return { ok: false, error: "that isn't a theme" };
		return { ok: true, write: { type: "plain", mode }, warnings: [], ...extra };
	}
	if (o.theme === null) return { ok: true, write: { type: "clear" }, warnings: [], ...extra };
	if (extra.accent) return { ok: true, write: { type: "keep" }, warnings: [], ...extra };
	return { ok: false, error: "that isn't a theme" };
}

export function applyWrite(current: Look | null, write: LookWrite): Look | null {
	if (write.type === "keep") return current;
	if (write.type === "plain") return { kind: "native", mode: write.mode };
	if (write.type === "paint") return { kind: "painted", theme: write.theme };
	if (!current || current.kind === "native") return current;
	return { kind: "native", mode: current.theme.base };
}

export function lookView(look: Look | null, accent: Accent = DEFAULT_ACCENT): LookView {
	if (!look) return { mode: null, theme: null, accent: accentWire(accent) };
	return { mode: modeOf(look), theme: look.kind === "painted" ? look.theme : null, accent: accentWire(accent) };
}

export function nightModeCookies(look: Look | null): readonly string[] {
	if (!look) return [];
	return [`night_mode=${modeOf(look) === "light" ? "0" : "2"}; ${NIGHT_MODE_ATTR}`];
}

export function clientLook(look: Look | null, accent: Accent = DEFAULT_ACCENT): ClientLook {
	return {
		night: look ? (modeOf(look) === "light" ? "0" : "2") : "2",
		theme: look?.kind === "painted" ? look.theme : null,
		accent: accentWire(accent),
		themeColor: themeColorOf(accent),
	};
}

export function paletteOf(look: Look | null, nightCookie?: string): AccountPalette | undefined {
	if (look?.kind === "painted" && look.theme.id === "dim") return "dim";
	if (look) return modeOf(look);
	if (nightCookie === "0") return "light";
	if (nightCookie === "1" || nightCookie === "2") return "dark";
	return undefined;
}

export const THEME_SCRIPT = String.raw`(function(){
	var X=window.__XITTER__||{};
	var theme=X.theme||null;
	var look=X.look||null;
	var accents=${JSON.stringify(ACCENTS)};
	var accentIds=${JSON.stringify(ACCENT_IDS)};
	var accentWire=X.accent!=null?X.accent:(look&&look.accent!=null?look.accent:null);
	var forcedColor=(look&&look.themeColor)||X.themeColor||"blue500";
	var scopes=${JSON.stringify(LINK_SCOPES)};
	var presets=X.themePresets||[];
	var sheet,fontSheet,accentSheet,at=0,timer,key="",accentKey="";
	var CHIRP='TwitterChirp,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif';
	var TICK='<svg viewBox="0 0 24 24" aria-hidden="true"><g><path d="M9.64 18.952l-5.55-4.861 1.317-1.504 3.951 3.459 8.459-10.948L19.4 6.32 9.64 18.952z"></path></g></svg>';
	var GOLD={"226, 183, 25":1,"212, 167, 44":1};
	var GREY={"130, 154, 171":1};
	function csrf(){return(document.cookie.match(/(?:^|;\s*)ct0=([^;]+)/)||[])[1]||""}
	function hexRgb(h){
		h=String(h||"").replace("#","");
		if(h.length===3)h=h.charAt(0)+h.charAt(0)+h.charAt(1)+h.charAt(1)+h.charAt(2)+h.charAt(2);
		return [parseInt(h.slice(0,2),16),parseInt(h.slice(2,4),16),parseInt(h.slice(4,6),16)];
	}
	function mix(a,b,t){
		return "#"+[0,1,2].map(function(i){var n=Math.round(a[i]+(b[i]-a[i])*t);return (n<16?"0":"")+n.toString(16)}).join("");
	}
	function fill(g){
		if(typeof g==="string")return g;
		return !g||!g.stops||!g.stops.length?"":(g.stops.length===1?g.stops[0]:"linear-gradient("+(g.angle||180)+"deg,"+g.stops.join(",")+")")
	}
	function avgOf(g){
		var stops=typeof g==="string"?[g]:(g&&g.stops?g.stops:["#000"]),acc=[0,0,0];
		stops.forEach(function(s){var c=hexRgb(s);acc[0]+=c[0];acc[1]+=c[1];acc[2]+=c[2]});
		var n=stops.length||1;
		return [acc[0]/n,acc[1]/n,acc[2]/n];
	}
	function hexOf(g){
		var a=avgOf(g);
		return "#"+[0,1,2].map(function(i){var x=Math.round(a[i]);return (x<16?"0":"")+x.toString(16)}).join("");
	}
	function rgba(h,a){var c=hexRgb(h);return "rgba("+c[0]+", "+c[1]+", "+c[2]+", "+a+")"}
	function fontOk(n){return typeof n==="string"&&/^[A-Za-z0-9 ]{1,40}$/.test(n)}
	function slugOf(n){return String(n).toLowerCase().replace(/ /g,"-")}
	function namedHex(id){return accents[id]||"#1d9bf0"}
	function resolveAccent(w){
		if(w==null)return {solid:"#1d9bf0",fill:"#1d9bf0",id:"blue500",custom:false};
		if(typeof w==="string"&&accents[w])return {solid:accents[w],fill:accents[w],id:w,custom:false};
		if(typeof w==="string"){
			var id=null,k;
			for(k in accents)if(accents[k]===w)id=k;
			return {solid:w,fill:w,id:id||"blue500",custom:!id};
		}
		var solid=hexOf(w),fl=fill(w)||solid;
		return {solid:solid,fill:fl,id:"blue500",custom:true};
	}
	var resolved=resolveAccent(accentWire);
	function lockLocal(obj){
		if(!obj||typeof obj!=="object")return obj;
		try{
			Object.defineProperty(obj,"themeColor",{configurable:true,enumerable:true,get:function(){return forcedColor},set:function(){}});
		}catch(e){obj.themeColor=forcedColor}
		return obj;
	}
	function seedThemeColor(){
		try{
			var s=window.__INITIAL_STATE__;
			if(s&&s.settings){
				s.settings._xtLocal=lockLocal(s.settings.local||{});
				try{
					Object.defineProperty(s.settings,"local",{
						configurable:true,
						get:function(){return s.settings._xtLocal},
						set:function(v){s.settings._xtLocal=lockLocal(v||{})}
					});
				}catch(e){s.settings.local=s.settings._xtLocal}
			}
		}catch(e){}
		try{
			var req=indexedDB.open("localforage");
			req.onsuccess=function(){
				var db=req.result;
				if(!db.objectStoreNames.contains("keyvaluepairs"))return;
				var tx=db.transaction("keyvaluepairs","readwrite");
				var store=tx.objectStore("keyvaluepairs");
				var g=store.get("device:rweb.settings");
				g.onsuccess=function(){
					var v=g.result;
					if(!v||typeof v!=="object")v={local:{}};
					if(!v.local||typeof v.local!=="object")v.local={};
					v.local.themeColor=forcedColor;
					store.put(v,"device:rweb.settings");
				};
			};
		}catch(e){}
	}
	function applyAccentVars(){
		var a=resolveAccent(accentWire),h=document.documentElement,hover=mix(hexRgb(a.solid),hexRgb("#0f1419"),0.12);
		h.style.setProperty("--xt-accent",a.solid);
		h.style.setProperty("--xt-accent-fill",a.fill);
		h.style.setProperty("--xt-accent-soft",rgba(a.solid,0.1));
		h.style.setProperty("--xt-accent-hover",hover);
		h.style.setProperty("--xt-accent-tint",mix(hexRgb(a.solid),hexRgb("#ffffff"),0.5));
		h.style.setProperty("--xt-accent-text",(hexRgb(a.solid)[0]*299+hexRgb(a.solid)[1]*587+hexRgb(a.solid)[2]*114)/1000>160?"#0f1419":"#ffffff");
		h.setAttribute("data-xitter-accent",a.custom?"custom":a.id);
		resolved=a;
		forcedColor=a.custom?"blue500":a.id;
	}
	function rgbKey(s){
		var m=/rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(s||"");
		return m?m[1]+", "+m[2]+", "+m[3]:"";
	}
	function keptCheck(svg){
		if(svg.querySelector("linearGradient,stop"))return true;
		var nodes=[svg].concat([].slice.call(svg.querySelectorAll("*"))),i,k,c;
		for(i=0;i<nodes.length;i++){
			c=getComputedStyle(nodes[i]);
			k=rgbKey(c.fill)||rgbKey(c.color);
			if(GOLD[k]||GREY[k])return true;
		}
		return false;
	}
	function accentGradUrl(){
		var a=resolved,id="xitter-accent-grad",ns="http://www.w3.org/2000/svg";
		if(!resolved.custom||resolved.fill.indexOf("gradient")<0)return resolved.solid;
		var g=document.getElementById(id);
		if(!g){
			var svg=document.createElementNS(ns,"svg");
			svg.setAttribute("width","0");svg.setAttribute("height","0");
			svg.style.cssText="position:absolute;width:0;height:0";
			var defs=document.createElementNS(ns,"defs");
			g=document.createElementNS(ns,"linearGradient");
			g.id=id;
			defs.appendChild(g);svg.appendChild(defs);
			document.documentElement.appendChild(svg);
		}
		var w=accentWire,stops=w&&w.stops?w.stops:[resolved.solid],ang=(w&&w.angle)||180,rad=ang*Math.PI/180;
		g.setAttribute("x1",String(0.5-0.5*Math.cos(rad)));
		g.setAttribute("y1",String(0.5-0.5*Math.sin(rad)));
		g.setAttribute("x2",String(0.5+0.5*Math.cos(rad)));
		g.setAttribute("y2",String(0.5+0.5*Math.sin(rad)));
		g.textContent="";
		stops.forEach(function(s,i){
			var st=document.createElementNS(ns,"stop");
			st.setAttribute("offset",stops.length===1?"0%":String(Math.round(i/(stops.length-1)*100))+"%");
			st.setAttribute("stop-color",s);
			g.appendChild(st);
		});
		return "url(#"+id+")";
	}
	function paintChecks(){
		var fill=accentGradUrl(),color=resolved.solid;
		document.querySelectorAll('svg[data-testid="icon-verified"]').forEach(function(svg){
			if(svg.closest("[data-xitter-badges],[data-xitter-frame],[data-xitter-framed],.xitter-deco,[data-xitter-decor-bg]"))return;
			if(keptCheck(svg))return;
			svg.style.setProperty("color",color,"important");
			svg.style.setProperty("fill",fill,"important");
			svg.querySelectorAll("path,g").forEach(function(n){
				var k=rgbKey(getComputedStyle(n).fill);
				if(GOLD[k]||GREY[k])return;
				n.style.setProperty("fill",fill,"important");
			});
		});
	}
	function varsOf(t){
		if(!t)return null;
		var avg=avgOf(t.bg),avgHex=hexOf(t.bg),tr=hexRgb(t.text||"#e7e9ea"),surface=hexOf(t.surface||avgHex),text=t.text,accent=hexOf(t.accent),accentFill=fill(t.accent)||accent;
		var muted=t.muted||mix(tr,hexRgb(avgHex),0.45),border=t.border||mix(tr,hexRgb(avgHex),0.82),link=t.link||accent;
		var reply=t.reply||accent,bookmark=t.bookmark||accent,like=t.like||"#f91880",repost=t.repost||"#00ba7c";
		return {
			"--xt-bg":fill(t.bg),"--xt-surface":fill(t.surface),"--xt-text":text,"--xt-secondary":t.secondary||mix(tr,hexRgb(avgHex),0.28),"--xt-muted":muted,"--xt-link":link,
			"--xt-border":border,"--xt-divider":t.divider||border,"--xt-accent":accent,"--xt-accent-fill":accentFill,"--xt-button":fill(t.button),"--xt-button-text":t.buttonText,
			"--xt-button-hover":t.buttonHover||mix(hexRgb(hexOf(t.button)),tr,0.12),"--xt-header":t.header?fill(t.header):"rgb("+Math.round(avg[0])+" "+Math.round(avg[1])+" "+Math.round(avg[2])+" / .85)",
			"--xt-hover":t.hover||("rgb("+tr[0]+" "+tr[1]+" "+tr[2]+" / .1)"),"--xt-input":t.inputBg||mix(hexRgb(surface),tr,0.08),"--xt-input-text":t.inputText||text,"--xt-input-border":t.inputBorder||border,
			"--xt-menu":t.menu?fill(t.menu):fill(t.surface),"--xt-tooltip":t.tooltip||mix(hexRgb(surface),tr,0.16),"--xt-icon":t.icon||muted,"--xt-icon-active":t.iconActive||text,
			"--xt-reply":reply,"--xt-repost":repost,"--xt-like":like,"--xt-bookmark":bookmark,"--xt-views":t.views||muted,
			"--xt-secondary-button":t.secondaryButton?fill(t.secondaryButton):"transparent","--xt-secondary-button-border":t.secondaryButtonBorder||border,"--xt-secondary-button-text":t.secondaryButtonText||text,
			"--xt-badge":t.badge||accent,"--xt-selection":t.selection||rgba(accent,0.28),"--xt-accent-soft":rgba(accent,0.1),"--xt-reply-soft":rgba(reply,0.1),"--xt-repost-soft":rgba(repost,0.1),"--xt-like-soft":rgba(like,0.1),"--xt-bookmark-soft":rgba(bookmark,0.1)
		};
	}
	function dropFonts(){document.querySelectorAll("link[data-xitter-font]").forEach(function(n){n.remove()})}
	function addFont(name){
		if(!fontOk(name))return;
		var slug=slugOf(name);
		if(document.querySelector('link[data-xitter-font="'+slug+'"]'))return;
		var l=document.createElement("link");
		l.rel="stylesheet";l.setAttribute("data-xitter-font",slug);l.href="/i/xitter/fonts/"+slug+"/fonts.css";
		document.head.appendChild(l);
	}
	function applyFonts(t){
		if(!fontSheet){fontSheet=document.createElement("style");fontSheet.setAttribute("data-xitter-font-css","");document.head.appendChild(fontSheet)}
		dropFonts();
		if(!t||!t.font){fontSheet.textContent="";return}
		var css="";
		if(fontOk(t.font.ui)){addFont(t.font.ui);css+='html[data-xitter-theme] body,html[data-xitter-theme] .css-146c3p1,html[data-xitter-theme] .css-1jxf684{font-family:"'+t.font.ui+'",'+CHIRP+'!important}'}
		if(fontOk(t.font.display)){addFont(t.font.display);css+='html[data-xitter-theme] [data-testid="User-Name"] span:first-of-type,html[data-xitter-theme] [data-testid="UserName"],html[data-xitter-theme] h1,html[data-xitter-theme] h2{font-family:"'+t.font.display+'",'+CHIRP+'!important}'}
		fontSheet.textContent=css;
	}
	var VAR_KEYS=["--xt-bg","--xt-surface","--xt-text","--xt-secondary","--xt-muted","--xt-link","--xt-border","--xt-divider","--xt-accent","--xt-accent-fill","--xt-button","--xt-button-text","--xt-button-hover","--xt-header","--xt-hover","--xt-input","--xt-input-text","--xt-input-border","--xt-menu","--xt-tooltip","--xt-icon","--xt-icon-active","--xt-reply","--xt-repost","--xt-like","--xt-bookmark","--xt-views","--xt-secondary-button","--xt-secondary-button-border","--xt-secondary-button-text","--xt-badge","--xt-selection","--xt-accent-soft","--xt-reply-soft","--xt-repost-soft","--xt-like-soft","--xt-bookmark-soft"];
	var ACCENT_KEYS={"--xt-accent":1,"--xt-accent-fill":1,"--xt-accent-soft":1,"--xt-accent-hover":1};
	function apply(t){
		theme=t;
		var h=document.documentElement;
		if(!t){
			h.removeAttribute("data-xitter-theme");
			VAR_KEYS.forEach(function(k){if(!ACCENT_KEYS[k])h.style.removeProperty(k)});
			if(sheet)sheet.textContent="";
			applyFonts(null);
			writeBase(false);
			key="";
			applyAccentVars();
			paintAccent();
			return;
		}
		h.setAttribute("data-xitter-theme",t.id||"custom");
		var v=varsOf(t),k;
		for(k in v)h.style.setProperty(k,v[k]);
		var sameBg=t.background&&X.theme&&X.theme.background&&t.background.mediaId&&t.background.mediaId===X.theme.background.mediaId;
		writeBase(!!sameBg);
		applyFonts(t);
		key="";
		applyAccentVars();
		paint();
		paintAccent();
	}
	function setNight(v){
		document.cookie="night_mode="+v+"; ${NIGHT_MODE_ATTR}";
	}
	function nudge(){
		if(!look)return;
		var digit=String(look.night);
		if((document.cookie.match(/(?:^|;\s*)night_mode=(\d)/)||[])[1]===digit)return;
		setNight(digit);
		try{if(sessionStorage.getItem("xitter-theme-nudge"))return;sessionStorage.setItem("xitter-theme-nudge","1")}catch(e){return}
		location.reload();
	}
	function norm(s){
		var m=/^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([0-9.]+))?\)$/.exec(s||"");
		if(!m)return "";
		if(m[4]==null||m[4]===""||Number(m[4])===1)return m[1]+", "+m[2]+", "+m[3];
		return m[1]+", "+m[2]+", "+m[3]+", "+m[4];
	}
	function pal(){
		return theme&&theme.base==="light"?{
			bg:{"255, 255, 255":1},
			text:{"15, 20, 25":1},
			secondary:{"55, 67, 77":1},
			muted:{"83, 100, 113":1},
			border:{"239, 243, 244":1,"207, 217, 222":1,"185, 202, 211":1},
			surface:{"247, 249, 249":1},
			menu:{"255, 255, 255":1},
			header:{"255, 255, 255, 0.85":1},
			buttonBg:{"15, 20, 25":1},
			buttonText:{"255, 255, 255":1},
			hover:{"15, 20, 25, 0.1":1},
			input:{"239, 243, 244":1,"247, 249, 249":1},
			tooltip:{"15, 20, 25":1},
			icon:{"83, 100, 113":1},
			iconFill:{"83, 100, 113":1},
			iconActiveFill:{"15, 20, 25":1}
		}:{
			bg:{"0, 0, 0":1},
			text:{"231, 233, 234":1},
			secondary:{"182, 185, 188":1},
			muted:{"113, 118, 123":1,"89, 93, 98":1},
			border:{"47, 51, 54":1,"51, 54, 57":1,"62, 65, 68":1,"75, 78, 82":1},
			surface:{"22, 24, 28":1,"32, 35, 39":1},
			menu:{"32, 35, 39":1,"42, 45, 48":1},
			header:{"0, 0, 0, 0.65":1},
			buttonBg:{"239, 243, 244":1},
			buttonText:{"15, 20, 25":1},
			hover:{"231, 233, 234, 0.1":1,"255, 255, 255, 0.03":1},
			input:{"32, 35, 39":1},
			tooltip:{"39, 44, 48, 0.75":1},
			icon:{"113, 118, 123":1,"100, 105, 109":1},
			iconFill:{"100, 105, 109":1,"130, 154, 171":1},
			iconActiveFill:{"231, 233, 234":1}
		};
	}
	function wrap(sel, pageBg){
		var skip=sel+':not(img):not(svg[data-testid="icon-verified"]):not(svg[aria-label="Translator account"]):not(.xitter-deco):not([data-xitter-badges]):not([data-xitter-frame]):not([data-xitter-framed]):not([data-xitter-decor-bg]):not(:is(svg[data-testid="icon-verified"] *,svg[aria-label="Translator account"] *,[data-xitter-badges] *,[data-xitter-frame],[data-xitter-framed] *,[data-xitter-decor-bg] *,.xitter-deco))';
		if(pageBg)return 'html[data-xitter-theme]:not([data-xitter-decor]) '+skip;
		return 'html[data-xitter-theme]:not([data-xitter-decor]) '+skip+',html[data-xitter-theme][data-xitter-decor] '+skip+':not([data-testid="primaryColumn"] *)';
	}
	function paint(){
		if(!theme||Date.now()-at<1000)return;
		at=Date.now();
		var p=pal(),found={pagebg:[],surface:[],text:[],secondary:[],muted:[],border:[],accentColor:[],accentBg:[],accentHover:[],accentSoft:[],accentOutline:[],button:[],buttonText:[],header:[],hover:[],menu:[],input:[],tooltip:[],icon:[],iconFill:[],iconActiveFill:[],repost:[],repostBg:[],like:[],likeBg:[],chirp:[]};
		function note(kind,sel){if(!found[kind])found[kind]=[];if(found[kind].indexOf(sel)<0)found[kind].push(sel)}
		[].forEach.call(document.styleSheets,function(ss){
			var rules;try{rules=ss.cssRules}catch(e){return}
			[].forEach.call(rules||[],function(r){
				if(!r.selectorText||!r.style||!/^\.[\w-]+$/.test(r.selectorText))return;
				var c=norm(r.style.color),bg=norm(r.style.backgroundColor),bd=norm(r.style.borderColor),fl=norm(r.style.fill),ol=norm(r.style.outlineColor),sel=r.selectorText;
				var ff=r.style.fontFamily||"";
				if(ff.indexOf("TwitterChirp")>=0)note("chirp",sel);
				if(p.bg[bg])note("pagebg",sel);
				if(p.surface[bg])note("surface",sel);
				if(p.menu[bg])note("menu",sel);
				if(p.header[bg])note("header",sel);
				if(p.buttonBg[bg])note("button",sel);
				if(p.hover[bg])note("hover",sel);
				if(p.input[bg])note("input",sel);
				if(p.tooltip[bg])note("tooltip",sel);
				if(p.text[c])note("text",sel);
				if(p.secondary[c])note("secondary",sel);
				if(p.muted[c])note("muted",sel);
				if(p.icon[c])note("icon",sel);
				if(p.buttonText[c]&&!p.text[c])note("buttonText",sel);
				if(c==="29, 155, 240"||c==="26, 140, 216")note("accentColor",sel);
				if(bg==="29, 155, 240")note("accentBg",sel);
				if(bg==="26, 140, 216")note("accentHover",sel);
				if(bg==="29, 155, 240, 0.1"||bg==="29, 155, 240, 0.12"||bg==="29, 155, 240, 0.14"||bg==="29, 155, 240, 0.2")note("accentSoft",sel);
				if(c==="0, 186, 124"||fl==="0, 186, 124")note("repost",sel);
				if(bg==="0, 186, 124"||bg==="0, 186, 124, 0.1"||bg==="0, 186, 124, 0.2")note("repostBg",sel);
				if(c==="249, 24, 128"||fl==="249, 24, 128")note("like",sel);
				if(bg==="249, 24, 128"||bg==="249, 24, 128, 0.1"||bg==="249, 24, 128, 0.2")note("likeBg",sel);
				if(p.border[bd])note("border",sel);
				if(fl==="29, 155, 240"||fl==="26, 140, 216")note("accentColor",sel);
				if(ol==="29, 155, 240")note("accentOutline",sel);
				if(p.iconFill[fl])note("iconFill",sel);
				if(p.iconActiveFill[fl])note("iconActiveFill",sel);
			});
		});
		var inline=[
			['text','[style*="color: rgb(231, 233, 234)"]','[style*="color: rgb(15, 20, 25)"]'],
			['muted','[style*="color: rgb(113, 118, 123)"]','[style*="color: rgb(83, 100, 113)"]'],
			['pagebg','[style*="background-color: rgb(0, 0, 0)"]','[style*="background-color: rgb(255, 255, 255)"]'],
			['surface','[style*="background-color: rgb(22, 24, 28)"]','[style*="background-color: rgb(32, 35, 39)"]','[style*="background-color: rgb(247, 249, 249)"]'],
			['button','[style*="background-color: rgb(239, 243, 244)"]','[style*="background-color: rgb(15, 20, 25)"]'],
			['accentColor','[style*="color: rgb(29, 155, 240)"]','[style*="fill: rgb(29, 155, 240)"]','[style*="color: rgb(26, 140, 216)"]'],
			['accentBg','[style*="background-color: rgb(29, 155, 240)"]'],
			['accentHover','[style*="background-color: rgb(26, 140, 216)"]'],
			['accentSoft','[style*="background-color: rgba(29, 155, 240, 0.1)"]','[style*="background-color: rgba(29, 155, 240, 0.12)"]','[style*="background-color: rgba(29, 155, 240, 0.2)"]'],
			['repost','[style*="color: rgb(0, 186, 124)"]'],
			['repostBg','[style*="background-color: rgb(0, 186, 124)"]','[style*="background-color: rgba(0, 186, 124, 0.1)"]'],
			['like','[style*="color: rgb(249, 24, 128)"]'],
			['likeBg','[style*="background-color: rgb(249, 24, 128)"]','[style*="background-color: rgba(249, 24, 128, 0.1)"]']
		];
		var light=theme.base==="light";
		inline.forEach(function(row){
			var kind=row[0];
			row.slice(1).forEach(function(sel){
				if(kind==="text"&&light&&sel.indexOf("15, 20, 25")>=0)note(kind,sel);
				else if(kind==="text"&&!light&&sel.indexOf("231, 233, 234")>=0)note(kind,sel);
				else if(kind==="muted"&&light&&sel.indexOf("83, 100, 113")>=0)note(kind,sel);
				else if(kind==="muted"&&!light&&sel.indexOf("113, 118, 123")>=0)note(kind,sel);
				else if(kind==="pagebg"&&light&&sel.indexOf("255, 255, 255")>=0)note(kind,sel);
				else if(kind==="pagebg"&&!light&&sel.indexOf("0, 0, 0")>=0)note(kind,sel);
				else if(kind==="surface")note(kind,sel);
				else if(kind==="button"&&light&&sel.indexOf("15, 20, 25")>=0)note(kind,sel);
				else if(kind==="button"&&!light&&sel.indexOf("239, 243, 244")>=0)note(kind,sel);
				else if(kind==="accentColor"||kind==="accentBg"||kind==="accentHover"||kind==="accentSoft"||kind==="repost"||kind==="repostBg"||kind==="like"||kind==="likeBg")note(kind,sel);
			});
		});
		var css=[],k;
		function add(kind,decl,pageBg){(found[kind]||[]).forEach(function(sel){css.push(wrap(sel,pageBg)+"{"+decl+"}")})}
		add("pagebg","background-color:transparent!important",true);
		add("surface","background:var(--xt-surface)!important",false);
		add("menu","background:var(--xt-menu)!important",false);
		add("header","background-color:var(--xt-header)!important",false);
		add("hover","background-color:var(--xt-hover)!important",false);
		add("input","background-color:var(--xt-input)!important;color:var(--xt-input-text)!important;border-color:var(--xt-input-border)!important",false);
		add("tooltip","background-color:var(--xt-tooltip)!important",false);
		add("text","color:var(--xt-text)!important",false);
		add("secondary","color:var(--xt-secondary)!important",false);
		add("muted","color:var(--xt-muted)!important",false);
		add("icon","color:var(--xt-icon)!important",false);
		add("iconFill","fill:var(--xt-icon)!important",false);
		add("iconActiveFill","fill:var(--xt-icon-active)!important",false);
		add("border","border-color:var(--xt-border)!important;border-bottom-color:var(--xt-divider)!important",false);
		add("button","background:var(--xt-button)!important",false);
		add("buttonText","color:var(--xt-button-text)!important",false);
		add("accentColor","color:var(--xt-accent)!important;fill:var(--xt-accent)!important",false);
		add("accentOutline","outline-color:var(--xt-accent)!important",false);
		add("accentBg","background:var(--xt-accent-fill,var(--xt-accent))!important",false);
		add("accentHover","background:var(--xt-accent-hover,var(--xt-accent))!important",false);
		add("accentSoft","background-color:var(--xt-accent-soft)!important",false);
		(found.accentColor||[]).forEach(function(sel){
			scopes.forEach(function(scope){
				css.push(wrap(scope+" "+sel)+"{color:var(--xt-link)!important}");
				css.push(wrap(scope+sel)+"{color:var(--xt-link)!important}");
			});
		});
		add("repost","color:var(--xt-repost)!important;fill:var(--xt-repost)!important",false);
		add("repostBg","background-color:var(--xt-repost-soft)!important",false);
		add("like","color:var(--xt-like)!important;fill:var(--xt-like)!important",false);
		add("likeBg","background-color:var(--xt-like-soft)!important",false);
		css.push('html[data-xitter-theme] [data-testid="reply"],html[data-xitter-theme] [data-testid="reply"] svg{color:var(--xt-reply)!important;fill:var(--xt-reply)!important}');
		css.push('html[data-xitter-theme] [data-testid="reply"]:hover [style*="background-color: rgba(29, 155, 240"]{background-color:var(--xt-reply-soft)!important}');
		css.push('html[data-xitter-theme] [data-testid="retweet"],html[data-xitter-theme] [data-testid="retweet"] svg{color:var(--xt-repost)!important;fill:var(--xt-repost)!important}');
		css.push('html[data-xitter-theme] [data-testid="like"],html[data-xitter-theme] [data-testid="like"] svg{color:var(--xt-like)!important;fill:var(--xt-like)!important}');
		css.push('html[data-xitter-theme] [data-testid="bookmark"],html[data-xitter-theme] [data-testid="bookmark"] svg,html[data-xitter-theme] [aria-label="Share post"] svg{color:var(--xt-bookmark)!important;fill:var(--xt-bookmark)!important}');
		css.push('html[data-xitter-theme] [data-testid="bookmark"]:hover [style*="background-color: rgba(29, 155, 240"],html[data-xitter-theme] [aria-label="Share post"]:hover [style*="background-color: rgba(29, 155, 240"]{background-color:var(--xt-bookmark-soft)!important}');
		css.push('html[data-xitter-theme] [data-testid="retweet"]:hover [style*="background-color: rgba(0, 186, 124"]{background-color:var(--xt-repost-soft)!important}');
		css.push('html[data-xitter-theme] [data-testid="like"]:hover [style*="background-color: rgba(249, 24, 128"]{background-color:var(--xt-like-soft)!important}');
		css.push('html[data-xitter-theme] [data-testid="app-text-transition-container"]{color:var(--xt-views)!important}');
		css.push('html[data-xitter-theme] a[href="/notifications"] div[dir],html[data-xitter-theme] [data-testid="AppTabBar_Notifications_Link"] div[style*="background"]{background-color:var(--xt-badge)!important}');
		css.push('html[data-xitter-theme] [data-testid="placementTracking"] button,html[data-xitter-theme] a[data-testid="editProfileButton"]{background:var(--xt-secondary-button)!important;border-color:var(--xt-secondary-button-border)!important;color:var(--xt-secondary-button-text)!important}');
		if(theme.font&&fontOk(theme.font.ui)){
			(found.chirp||[]).forEach(function(sel){css.push('html[data-xitter-theme] '+sel+'{font-family:"'+theme.font.ui+'",'+CHIRP+'!important}')});
		}
		var next=css.join("");
		if(next===key)return;
		key=next;
		if(!sheet){sheet=document.createElement("style");sheet.setAttribute("data-xitter-theme-css","");document.head.appendChild(sheet)}
		sheet.textContent=next;
	}
	function wrapAccent(sel){
		return 'html[data-xitter-accent] '+sel+':not(img):not(svg[data-testid="icon-verified"]):not(svg[aria-label="Translator account"]):not(.xitter-deco):not([data-xitter-badges]):not([data-xitter-frame]):not([data-xitter-framed]):not([data-xitter-decor-bg]):not(:is(svg[data-testid="icon-verified"] *,svg[aria-label="Translator account"] *,[data-xitter-badges] *,[data-xitter-frame],[data-xitter-framed] *,[data-xitter-decor-bg] *,.xitter-deco,[aria-label="Color options"] *))';
	}
	function paintAccent(){
		applyAccentVars();
		var css=[];
		function add(sel,decl){css.push(wrapAccent(sel)+"{"+decl+"}")}
		[].forEach.call(document.styleSheets,function(ss){
			var rules;try{rules=ss.cssRules}catch(e){return}
			[].forEach.call(rules||[],function(r){
				if(!r.selectorText||!r.style||!/^\.[\w-]+$/.test(r.selectorText))return;
				var c=norm(r.style.color),bg=norm(r.style.backgroundColor),fl=norm(r.style.fill),ol=norm(r.style.outlineColor),bd=norm(r.style.borderColor),sel=r.selectorText;
				if(c==="29, 155, 240"||c==="26, 140, 216"||fl==="29, 155, 240"||fl==="26, 140, 216")add(sel,"color:var(--xt-accent)!important;fill:var(--xt-accent)!important");
				if(bg==="29, 155, 240")add(sel,"background:var(--xt-accent-fill,var(--xt-accent))!important");
				if(bg==="26, 140, 216")add(sel,"background:var(--xt-accent-hover,var(--xt-accent))!important");
				if(bg==="142, 205, 248"||bg==="107, 201, 251")add(sel,"background-color:var(--xt-accent-tint)!important");
				if(/^29, 155, 240, /.test(bg)||/^26, 140, 216, /.test(bg))add(sel,"background-color:color-mix(in srgb,var(--xt-accent) "+Math.round(Number(bg.split(", ")[3])*100)+"%,transparent)!important");
				if(ol==="29, 155, 240"||bd==="29, 155, 240"||ol==="142, 205, 248"||bd==="142, 205, 248")add(sel,"outline-color:var(--xt-accent)!important;border-color:var(--xt-accent)!important");
				if(/29,\s*155,\s*240|26,\s*140,\s*216|142,\s*205,\s*248/.test(r.style.backgroundImage||""))add(sel,"background-image:linear-gradient(90deg,var(--xt-accent),var(--xt-accent-tint))!important");
			});
		});
		add('[style*="color: rgb(29, 155, 240)"]',"color:var(--xt-accent)!important;fill:var(--xt-accent)!important");
		add('[style*="fill: rgb(29, 155, 240)"]',"fill:var(--xt-accent)!important");
		add('[style*="background-color: rgb(29, 155, 240)"]',"background:var(--xt-accent-fill,var(--xt-accent))!important");
		add('[style*="background-color: rgb(26, 140, 216)"]',"background:var(--xt-accent-hover,var(--xt-accent))!important");
		add('[style*="background-color: rgba(29, 155, 240"]',"background-color:var(--xt-accent-soft)!important");
		add('[style*="border-color: rgb(29, 155, 240)"]',"border-color:var(--xt-accent)!important");
		add('[style*="border-color: rgb(26, 140, 216)"]',"border-color:var(--xt-accent-hover,var(--xt-accent))!important");
		add('[style*="background-color: rgb(142, 205, 248)"]',"background-color:var(--xt-accent-tint)!important");
		css.push('html[data-xitter-accent] [data-testid="tweetButton"],html[data-xitter-accent] [data-testid="tweetButtonInline"]{background:var(--xt-accent-fill,var(--xt-accent))!important;border-color:transparent!important}');
		css.push('html[data-xitter-accent] [data-testid="tweetButton"] div,html[data-xitter-accent] [data-testid="tweetButtonInline"] div{color:var(--xt-accent-text,#fff)!important}');
		var next=css.join("");
		if(next!==accentKey){
			accentKey=next;
			if(!accentSheet){accentSheet=document.createElement("style");accentSheet.setAttribute("data-xitter-accent-css","");document.head.appendChild(accentSheet)}
			accentSheet.textContent=next;
		}
		paintChecks();
	}
	function post(body,then){
		fetch("/i/api/xitter/theme",{method:"POST",credentials:"same-origin",headers:{"content-type":"application/json","x-csrf-token":csrf()},body:JSON.stringify(body)})
			.then(function(r){return r.json().then(function(d){return {ok:r.ok,d:d}})})
			.then(function(x){if(then)then(x.ok,x.d)},function(){});
	}
	function el(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text)e.textContent=text;return e}
	function chipBg(g){return g&&g.stops?fill(g):"#15202b"}
	var wired=false,picking=false;
	function circle(card){var r=card.querySelector('[role="radio"]');return r&&r.firstElementChild}
	function unselectCard(card){
		card.style.borderColor="rgb(51, 54, 57)";
		card.style.borderWidth="1px";
		var d=circle(card);
		if(d){d.style.backgroundColor="rgba(0, 0, 0, 0)";d.style.borderColor="rgb(185, 202, 211)";d.innerHTML=""}
		var i=card.querySelector("input");if(i)i.checked=false;
	}
	function selectCard(card){
		var acc=resolved.solid||"#1d9bf0";
		card.style.borderColor=acc;
		card.style.borderWidth="2px";
		var d=circle(card);
		if(d){d.style.backgroundColor=acc;d.style.borderColor=acc;if(!d.querySelector("svg"))d.innerHTML=TICK}
		var i=card.querySelector("input");if(i)i.checked=true;
	}
	function mark(){
		var dim=document.querySelector("[data-xitter-dim]");
		document.querySelectorAll("[data-xitter-native]").forEach(function(c){
			if(theme)unselectCard(c);
			else{
				var i=c.querySelector("input");
				if(i&&i.checked)selectCard(c);
			}
		});
		if(dim){
			if(theme&&theme.id==="dim")selectCard(dim);
			else if(theme)unselectCard(dim);
			else{
				var i=dim.querySelector("input");
				if(i&&i.checked)selectCard(dim);
			}
			dim.setAttribute("data-on",theme&&theme.id==="dim"?"1":"0");
		}
		document.querySelectorAll("[data-xitter-swatch]").forEach(function(c){
			var on=theme&&theme.id===c.getAttribute("data-xitter-swatch");
			c.setAttribute("data-on",on?"1":"0");
			c.style.borderColor=on?(resolved.solid||"#1d9bf0"):"transparent";
		});
	}
	function markColors(group){
		var a=resolveAccent(accentWire),on=a.custom?"custom":a.id;
		group.setAttribute("data-custom",a.custom?"1":"0");
		group.querySelectorAll("[data-xitter-color]").forEach(function(card){
			var id=card.getAttribute("data-xitter-color");
			var sel=id===on;
			var radio=card.querySelector("input[type=radio]");
			if(radio)radio.checked=!!sel;
			card.querySelectorAll("svg").forEach(function(s){
				if(s.querySelector("circle")&&!s.querySelector("path")){
					if(id==="custom")s.style.display="none";
					return;
				}
				if(id!=="custom")s.style.display=sel?"":"none";
			});
			if(id==="custom"){
				var host=card.querySelector('[role="radio"]')||card;
				var tick=card.querySelector("[data-xitter-tick]");
				if(sel){
					if(!tick){
						tick=document.createElement("div");
						tick.setAttribute("data-xitter-tick","");
						tick.innerHTML=TICK;
						tick.style.cssText="position:absolute;inset:0;display:grid;place-items:center;pointer-events:none";
						var svg=tick.querySelector("svg");
						if(svg)svg.style.cssText="width:25px;height:25px;fill:#fff";
						host.style.position="relative";
						host.appendChild(tick);
					}
				}else if(tick)tick.remove();
			}
		});
	}
	function openCustom(group){
		var inp=document.getElementById("xitter-accent-pick");
		if(!inp){
			inp=document.createElement("input");
			inp.type="color";inp.id="xitter-accent-pick";
			inp.style.cssText="position:fixed;left:-99px;width:1px;height:1px;opacity:0";
			document.body.appendChild(inp);
			inp.addEventListener("input",function(){
				if(!inp.value)return;
				forcedColor="blue500";
				accentWire=inp.value;
				applyAccentVars();
				paintAccent();
				markColors(group);
			});
			inp.addEventListener("change",function(){
				post({accent:inp.value},function(ok,d){
					if(ok&&d&&d.accent!=null)accentWire=d.accent;
					if(ok&&d&&d.theme)theme=d.theme;
					applyAccentVars();
					paintAccent();
					markColors(group);
				});
			});
		}
		var a=resolveAccent(accentWire);
		inp.value=/^#[0-9a-f]{6}$/i.test(a.solid)?a.solid:"#ff3d7f";
		inp.click();
	}
	function colors(){
		if(location.pathname.indexOf("/settings/display")!==0)return;
		var group=document.querySelector('[role="radiogroup"][aria-label="Color options"]');
		if(!group)return;
		var kids=[].filter.call(group.children,function(n){return n.getAttribute("data-xitter-color")!=="custom"&&n.querySelector('[role="radio"],input[type="radio"]')});
		kids.forEach(function(card,i){
			var id=accentIds[i];
			if(!id)return;
			if(card.getAttribute("data-xitter-wired"))return;
			card.setAttribute("data-xitter-wired","1");
			card.setAttribute("data-xitter-color",id);
			card.addEventListener("click",function(){
				if(picking)return;
				forcedColor=id;
				accentWire=id;
				post({accent:id},function(ok,d){
					if(ok&&d&&d.accent!=null)accentWire=d.accent;
					if(ok&&d&&d.theme)theme=d.theme;
					applyAccentVars();
					paintAccent();
					markColors(group);
				});
			},true);
		});
		if(!group.querySelector('[data-xitter-color="custom"]')){
			var last=kids[kids.length-1]||group.lastElementChild;
			if(last){
				var custom=last.cloneNode(true);
				custom.removeAttribute("data-xitter-wired");
				custom.setAttribute("data-xitter-color","custom");
				var lab=custom.querySelector("input");
				if(lab){lab.setAttribute("aria-label","Custom");lab.checked=false;lab.name="xitter-accent-custom"}
				var vis=custom.querySelector('[role="radio"]')||custom.firstElementChild;
				if(vis){
					vis.style.background="conic-gradient(#ff3d7f,#ffd400,#00ba7c,#1d9bf0,#7856ff,#f91880,#ff3d7f)";
					vis.style.borderRadius="9999px";
					vis.style.backgroundImage="conic-gradient(#ff3d7f,#ffd400,#00ba7c,#1d9bf0,#7856ff,#f91880,#ff3d7f)";
				}
				var disc=custom.querySelector("svg");
				if(disc)disc.style.display="none";
				custom.addEventListener("click",function(e){
					e.preventDefault();e.stopPropagation();
					if(picking)return;
					picking=true;
					var blue=group.querySelector('[data-xitter-color="blue500"]');
					try{if(blue)blue.click()}catch(err){}
					picking=false;
					forcedColor="blue500";
					openCustom(group);
				},true);
				group.appendChild(custom);
			}
		}
		markColors(group);
	}
	function display(){
		if(location.pathname.indexOf("/settings/display")!==0)return;
		colors();
		if(document.querySelector("[data-xitter-dim]")){mark();return}
		var group=document.querySelector('[role="radiogroup"][aria-label="Background options"]');
		if(!group)return;
		var defCard,lightsCard,i;
		for(i=0;i<group.children.length;i++){
			var card=group.children[i],lab=card.querySelector("span"),tx=lab&&lab.textContent;
			if(tx==="Default")defCard=card;
			if(tx==="Lights out")lightsCard=card;
		}
		if(!defCard||!lightsCard)return;
		defCard.setAttribute("data-xitter-native","default");
		lightsCard.setAttribute("data-xitter-native","lights");
		var dim=lightsCard.cloneNode(true);
		dim.setAttribute("data-xitter-dim","");
		dim.removeAttribute("data-xitter-native");
		dim.querySelectorAll("span").forEach(function(s){if(!s.childElementCount&&s.textContent==="Lights out")s.textContent="Dim"});
		dim.style.backgroundColor="#15202B";
		var inp=dim.querySelector("input");
		if(inp){inp.removeAttribute("name");inp.setAttribute("aria-label","Dim");inp.checked=false}
		unselectCard(dim);
		group.insertBefore(dim,lightsCard);
		function onMode(mode){
			return function(){
				if(picking)return;
				post({mode:mode},function(){apply(null);mark()});
			};
		}
		defCard.addEventListener("click",onMode("light"),true);
		lightsCard.addEventListener("click",onMode("dark"),true);
		dim.addEventListener("click",function(e){
			e.preventDefault();e.stopPropagation();
			picking=true;
			try{lightsCard.click()}catch(err){}
			picking=false;
			post({theme:{id:"dim"}},function(ok,d){
				if(ok&&d&&d.theme)apply(d.theme);else apply({id:"dim",base:"dark",bg:{stops:["#15202b"],angle:180},surface:"#1e2732",text:"#f7f9f9",accent:"#1d9bf0",button:{stops:["#eff3f4"],angle:180},buttonText:"#0f1419",muted:"#8b98a5",border:"#38444d"});
				mark();
			});
		},true);
		var face=CHIRP, muted="rgb(113, 118, 123)", accent=resolved.solid||"#1d9bf0";
		var sample=defCard.querySelector("span")||defCard;
		var fam=getComputedStyle(sample).fontFamily;
		if(fam&&!/^\s*(serif|Times|Times New Roman)\s*$/i.test(fam))face=fam;
		var rootAcc=getComputedStyle(document.documentElement).getPropertyValue("--xt-accent").trim();
		if(rootAcc)accent=rootAcc;
		else{
			var ring=getComputedStyle(dim).borderColor;
			if(ring&&ring!=="rgb(51, 54, 57)"&&ring!=="rgba(0, 0, 0, 0)")accent=ring;
		}
		var n,spans=document.querySelectorAll("span");
		for(n=0;n<spans.length;n++){
			if(/Manage your font size/.test(spans[n].textContent||"")){muted=getComputedStyle(spans[n]).color;break}
		}
		var bar=el("div");
		bar.setAttribute("data-xitter-themes","");
		bar.style.cssText="display:flex;flex-wrap:wrap;align-items:center;gap:10px;padding:12px 16px;box-sizing:border-box;width:100%;font-family:"+face+";font-size:15px;line-height:20px";
		var lab=el("span","","Custom themes");
		lab.style.cssText="font-family:inherit;font-size:15px;line-height:20px;color:"+muted+";margin:0";
		bar.appendChild(lab);
		presets.forEach(function(p){
			var b=el("button");
			b.type="button";
			b.title=p.name||p.id;
			b.setAttribute("data-xitter-swatch",p.id);
			b.setAttribute("aria-label",p.name||p.id);
			b.style.cssText="width:30px;height:30px;min-width:30px;min-height:30px;border-radius:9999px;border:2px solid transparent;padding:0;margin:0;cursor:pointer;background:"+chipBg(p.bg)+";flex:none;font-family:inherit;appearance:none;-webkit-appearance:none";
			b.addEventListener("click",function(){
				post({theme:{id:p.id}},function(){location.reload()});
			});
			bar.appendChild(b);
		});
		var a=el("a","","Customize…");
		a.href="/account/theme";
		a.style.cssText="font-family:inherit;font-size:15px;line-height:20px;color:"+accent+";text-decoration:none;margin:0";
		a.addEventListener("click",function(e){e.preventDefault();e.stopPropagation();location.assign("/account/theme")},true);
		bar.appendChild(a);
		var host=group.parentElement;
		if(host&&host.parentNode)host.parentNode.insertBefore(bar,host.nextSibling);
		if(!wired){
			wired=true;
			var st=document.createElement("style");
			st.textContent='[data-xitter-themes] a{text-decoration:none}[data-xitter-themes] a:hover{text-decoration:underline}[data-xitter-swatch][data-on="1"]{border-color:var(--xt-accent,'+accent+')!important}';
			document.head.appendChild(st);
		}
		mark();
	}
	var base=document.createElement("style");
	base.setAttribute("data-xitter-theme-base","");
	function writeBase(on){
		base.textContent='html[data-xitter-theme] ::selection{background:var(--xt-selection)}'+
			'html[data-xitter-theme]:not([data-xitter-decor]),html[data-xitter-theme]:not([data-xitter-decor]) body{background:var(--xt-bg)!important;background-attachment:fixed!important}'+
			'html[data-xitter-theme]:not([data-xitter-decor]) #react-root>div>div,html[data-xitter-theme]:not([data-xitter-decor]) #react-root>div>div>div:not([data-testid]){background-color:transparent!important}'+
			(on&&typeof X.pageChrome==="string"?X.pageChrome:"");
	}
	writeBase(!!(theme&&theme.background));
	document.head.appendChild(base);
	seedThemeColor();
	applyAccentVars();
	if(theme)apply(theme);
	else paintAccent();
	nudge();
	function tick(){if(theme)paint();paintAccent();display()}
	tick();
	new MutationObserver(function(){if(!timer)timer=setTimeout(function(){timer=null;tick()},150)}).observe(document.documentElement,{childList:true,subtree:true});
})();`;

const PAGE_CSS = `
form.swatches{display:grid;grid-template-columns:repeat(auto-fill,minmax(128px,1fr));gap:8px;width:100%;justify-items:stretch;align-items:stretch}
.pick{display:flex;flex-direction:column;align-items:stretch;gap:8px;width:100%;height:100%;min-width:0;padding:8px;border-radius:12px;background:var(--surface);color:var(--text);font-weight:500;white-space:normal;text-align:left}
.pick .swatch{width:100%;aspect-ratio:16/9;height:auto;border-radius:8px}
.pick .name{font-size:13px;line-height:16px;font-weight:500;min-height:32px}
.pick.on{outline:2px solid var(--accent);outline-offset:0}
@media (hover:hover){.pick:hover:not(:disabled){background:var(--hover)}}
.choice{display:flex;align-items:center;gap:8px;color:var(--text);margin:0;font-size:15px}
.choice input{width:20px;min-height:20px;height:20px;margin:0;padding:0;accent-color:var(--accent)}
form.editor{display:grid;gap:16px;width:100%;max-width:100%;min-width:0;justify-items:stretch}
.toks{display:grid;grid-template-columns:1fr 1fr;gap:8px 16px;width:100%;min-width:0}
@media (max-width:520px){.toks{grid-template-columns:1fr}}
.tok{display:grid;grid-template-columns:1fr auto auto auto;gap:6px;align-items:center;margin:0;min-width:0}
.tok > span{font-size:13px;color:var(--muted);min-width:0}
.tok input[type=color]{width:40px;height:28px;min-height:28px;padding:1px;border:1px solid var(--outline);border-radius:6px;background:none;cursor:pointer}
.tok .x,.tok .g{min-height:28px;min-width:28px;padding:0 8px;font-size:14px}
.tok .g[aria-pressed="true"]{background:var(--hover)}
.grow{display:grid;gap:8px;width:100%;min-width:0}
.grow > span{font-size:13px;line-height:16px;color:var(--muted)}
.grow-tools{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.tiny{min-height:28px;padding:0 10px;font-size:13px}
.gstop{display:flex;flex-wrap:wrap;gap:6px;align-items:center;grid-column:1/-1}
.gstop label{display:grid;gap:2px;margin:0;font-size:11px}
.gstop input[type=color]{width:40px;height:28px;min-height:28px;padding:1px;border:1px solid var(--outline);border-radius:6px;background:none}
.ang{display:flex;align-items:center;gap:8px;flex:1 1 160px;min-width:0;margin:0;font-size:13px;line-height:16px;color:var(--muted)}
.ang input[type=range]{flex:1;min-width:0;width:auto;min-height:24px;padding:0;border:0;background:transparent}
.ang .deg{font-variant-numeric:tabular-nums;min-width:3.5ch}
.h3{font-size:13px;font-weight:700;margin:0;color:var(--text)}
details.adv .h3{margin:12px 0 4px}
details.adv{border:1px solid var(--border);border-radius:12px;padding:8px 12px;width:100%;min-width:0}
details.adv summary{cursor:pointer;font-weight:700}
.fonts{display:grid;gap:12px;width:100%;min-width:0}
.fg{display:grid;gap:6px;min-width:0}
.fg > span{font-size:13px;line-height:16px;color:var(--muted)}
.fg .line{display:flex;gap:8px;align-items:center;min-width:0}
.fg .line input{flex:1 1 auto;min-width:0;width:auto;min-height:36px;font-size:15px}
.fg .fp{margin:0;font-size:14px;line-height:18px;color:var(--text)}
.live{width:100%;min-width:0;border:1px solid var(--border);border-radius:16px;overflow:hidden}
@media (min-width:601px){.live{position:sticky;top:61px;z-index:1}}
.live .stage{display:grid;grid-template-columns:56px minmax(0,1fr) minmax(0,104px);color:var(--pv-text,#e7e9ea);background:var(--pv-bg,#000)}
.live .nav{padding:8px 6px;display:grid;gap:8px;align-content:start;font-size:12px;font-weight:700;background:var(--pv-header,transparent)}
.live .nav .on{color:var(--pv-icon-active,var(--pv-text))}
.live .feed{border-inline:1px solid var(--pv-border,#2f3336);padding:8px;background:transparent;min-width:0}
.live .cardp{display:grid;grid-template-columns:32px minmax(0,1fr);gap:8px;padding:6px;border-radius:12px;background:var(--pv-surface,#16181c);position:relative}
.live .ava{width:32px;height:32px;border-radius:50%;background:var(--pv-muted,#71767b)}
.live .who{font-size:13px}
.live .who b{color:var(--pv-text,#e7e9ea);font-family:var(--pv-display,inherit)}
.live .who span{color:var(--pv-muted,#71767b)}
.live .body{font-family:var(--pv-ui,inherit)}
.live a.lk{color:var(--pv-link,var(--pv-accent,#1d9bf0))}
.live .acts{display:flex;gap:12px;margin-top:8px;font-size:13px}
.live .acts span{display:flex;align-items:center;gap:4px}
.live .acts .r{color:var(--pv-reply)}
.live .acts .t{color:var(--pv-repost)}
.live .acts .h{color:var(--pv-like)}
.live .acts .b{color:var(--pv-bookmark,var(--pv-accent))}
.live .acts .v{color:var(--pv-views,var(--pv-muted))}
.live .cardp:hover{background:color-mix(in srgb, var(--pv-text) 10%, var(--pv-surface))}
.live .badge{position:absolute;top:8px;right:8px;min-width:16px;height:16px;padding:0 4px;border-radius:9999px;background:var(--pv-badge);color:#fff;font-size:11px;line-height:16px;text-align:center}
.live .side{padding:8px 6px;display:grid;gap:6px;align-content:start;min-width:0}
.live .search{height:28px;min-height:28px;width:100%;border-radius:9999px;background:var(--pv-input,var(--pv-surface));border:1px solid var(--pv-input-border,var(--pv-border));color:var(--pv-input-text,var(--pv-text));padding:0 10px;font:inherit;font-size:12px}
.live .menu{background:var(--pv-menu,var(--pv-surface));border:1px solid var(--pv-border);border-radius:12px;padding:8px;font-size:13px}
.live .pill,.live .pill:hover,.live .ghost,.live .ghost:hover{min-height:28px;width:100%;padding:0 8px;border-radius:9999px;font:inherit;font-size:12px;font-weight:700;cursor:default}
.live .pill,.live .pill:hover{border:0;background:var(--pv-button,#eff3f4);color:var(--pv-button-text,#0f1419)}
.live .ghost,.live .ghost:hover{border:1px solid var(--pv-sec-border,var(--pv-border));background:var(--pv-sec-button,transparent);color:var(--pv-sec-text,var(--pv-text))}
@media (max-width:600px){
.live{position:static}
.live .stage{grid-template-columns:minmax(0,1fr)}
.live .nav,.live .side{display:none}
.live .feed{border-inline:0}
}
.share{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.share a,.file{display:inline-flex;align-items:center;min-height:36px;padding:0 12px;border-radius:9999px;border:1px solid var(--border);text-decoration:none;color:var(--text)}
.file input{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
#theme-import-errors{margin:0;padding:0;list-style:none;color:#f4212e}
#theme-import-errors:not(:empty){padding:10px 12px;border:1px solid #f4212e;border-radius:12px;background:rgba(244,33,46,.08)}
#theme-import-errors li.head{font-weight:700}
#theme-import-errors li{margin:0 0 4px}
.bgopt{display:grid;gap:8px}
.bgopt .line{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.bgopt select{min-height:36px;border-radius:8px;border:1px solid var(--outline);background:var(--field);color:var(--text)}
#bg-preview{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:0;pointer-events:none}
.live .stage{position:relative;z-index:1}
.note{margin:0;padding:8px 10px;border-radius:8px;font-size:13px;line-height:16px;background:rgb(255 212 0 / .16);color:#8a5800}
:root[data-theme="dark"] .note,:root[data-theme="dim"] .note{color:#e6b800;background:rgb(255 212 0 / .12)}
.warns{display:grid;gap:4px}
.warns p{color:#8a5800;font-size:13px}
:root[data-theme="dark"] .warns p,:root[data-theme="dim"] .warns p{color:#e6b800}
.savebar{display:flex;gap:8px;align-items:center;width:100%;padding:4px 0 0}
.savebar button[type=submit]{flex:1}
`;

const EDITOR_SCRIPT = String.raw`(function(){
	var f=document.getElementById("custom"),prev=document.getElementById("preview"),warn=document.getElementById("warns");
	if(!f||!prev)return;
	function val(name){return f[name]?f[name].value:""}
	function setv(name,v){if(f[name])f[name].value=v}
	function flagged(name){return val(name+"_set")==="1"}
	function flag(name,on){setv(name+"_set",on?"1":"")}
	function stops(name){return [].map.call(f.querySelectorAll('input[name="'+name+'"]'),function(i){return i.value})}
	function hexRgb(h){h=String(h||"").replace("#","");if(h.length===3)h=h.charAt(0)+h.charAt(0)+h.charAt(1)+h.charAt(1)+h.charAt(2)+h.charAt(2);return [parseInt(h.slice(0,2),16),parseInt(h.slice(2,4),16),parseInt(h.slice(4,6),16)]}
	function toHex(c){return "#"+c.map(function(n){n=Math.round(Math.max(0,Math.min(255,n)));return (n<16?"0":"")+n.toString(16)}).join("")}
	function mix(a,b,t){var A=hexRgb(a),B=hexRgb(b);return toHex([A[0]+(B[0]-A[0])*t,A[1]+(B[1]-A[1])*t,A[2]+(B[2]-A[2])*t])}
	function lin(c){var s=c/255;return s<=0.03928?s/12.92:Math.pow((s+0.055)/1.055,2.4)}
	function lum(h){var c=hexRgb(h);return 0.2126*lin(c[0])+0.7152*lin(c[1])+0.0722*lin(c[2])}
	function contrast(a,b){var L1=lum(a),L2=lum(b),hi=Math.max(L1,L2),lo=Math.min(L1,L2);return (hi+0.05)/(lo+0.05)}
	function fill(stops,angle){return !stops||!stops.length?"#000":(stops.length<=1?stops[0]:"linear-gradient("+angle+"deg,"+stops.join(",")+")")}
	function avg(stops){if(!stops.length)return "#000";var a=[0,0,0];stops.forEach(function(s){var c=hexRgb(s);a[0]+=c[0];a[1]+=c[1];a[2]+=c[2]});return toHex([a[0]/stops.length,a[1]/stops.length,a[2]/stops.length])}
	function fontOk(n){return /^[A-Za-z0-9 ]{1,40}$/.test(n)}
	function loadFont(name){
		if(!fontOk(name))return;
		var slug=name.toLowerCase().replace(/ /g,"-"),id="xf-"+slug;
		if(document.getElementById(id))return;
		var l=document.createElement("link");l.id=id;l.rel="stylesheet";l.href="/i/xitter/fonts/"+slug+"/fonts.css?family="+encodeURIComponent(name);document.head.appendChild(l);
	}
	var ADV=["link","secondary","muted","border","divider","hover","inputBg","inputText","inputBorder","header","menu","tooltip","icon","iconActive","reply","repost","like","bookmark","views","secondaryButton","secondaryButtonBorder","secondaryButtonText","buttonHover","badge","selection"];
	function basics(){
		return {bg:stops("bg"),bgA:val("bg_angle")||"180",surface:val("surface"),text:val("text"),accent:val("accent"),button:stops("button"),btnA:val("button_angle")||"180",buttonText:val("buttonText")}
	}
	function derivedOf(){
		var b=basics(),avgBg=avg(b.bg),tr=b.text,muted=mix(tr,avgBg,0.45),border=mix(tr,avgBg,0.82);
		return {
			link:b.accent,secondary:mix(tr,avgBg,0.28),muted:muted,border:border,divider:border,hover:b.text,
			inputBg:mix(b.surface,tr,0.08),inputText:tr,inputBorder:border,header:avgBg,menu:b.surface,tooltip:mix(b.surface,tr,0.16),
			icon:muted,iconActive:tr,reply:b.accent,repost:"#00ba7c",like:"#f91880",bookmark:b.accent,views:muted,
			secondaryButton:b.surface,secondaryButtonBorder:border,secondaryButtonText:tr,buttonHover:mix(avg(b.button),tr,0.12),badge:b.accent,selection:b.accent
		};
	}
	function fillVal(name,fallback){
		if(val(name+"_grad")==="1"){
			var st=stops(name+"_stop");
			return fill(st.length?st:[val(name)||fallback],val(name+"_angle")||"180");
		}
		return (name==="surface"||flagged(name))?val(name)||fallback:fallback;
	}
	function draw(){
		var b=basics(),d=derivedOf(),ui=val("font_ui").trim(),display=val("font_display").trim();
		function tok(name,fallback){return flagged(name)?val(name):fallback}
		prev.style.setProperty("--pv-bg",fill(b.bg,b.bgA));
		prev.style.setProperty("--pv-surface",fillVal("surface",b.surface));
		prev.style.setProperty("--pv-text",b.text);
		prev.style.setProperty("--pv-button",fill(b.button,b.btnA));
		prev.style.setProperty("--pv-button-text",b.buttonText);
		prev.style.setProperty("--pv-accent",fillVal("accent",b.accent));
		prev.style.setProperty("--pv-link",tok("link",d.link));
		prev.style.setProperty("--pv-muted",tok("muted",d.muted));
		prev.style.setProperty("--pv-border",tok("border",d.border));
		prev.style.setProperty("--pv-input",tok("inputBg",d.inputBg));
		prev.style.setProperty("--pv-input-text",tok("inputText",d.inputText));
		prev.style.setProperty("--pv-input-border",tok("inputBorder",d.inputBorder));
		prev.style.setProperty("--pv-menu",fillVal("menu",d.menu));
		prev.style.setProperty("--pv-reply",tok("reply",d.reply));
		prev.style.setProperty("--pv-repost",tok("repost",d.repost));
		prev.style.setProperty("--pv-like",tok("like",d.like));
		prev.style.setProperty("--pv-bookmark",tok("bookmark",d.bookmark));
		prev.style.setProperty("--pv-views",tok("views",d.views));
		prev.style.setProperty("--pv-icon-active",tok("iconActive",d.iconActive));
		prev.style.setProperty("--pv-header",fillVal("header",d.header));
		prev.style.setProperty("--pv-badge",tok("badge",d.badge));
		prev.style.setProperty("--pv-sec-button",fillVal("secondaryButton",d.secondaryButton));
		prev.style.setProperty("--pv-sec-border",tok("secondaryButtonBorder",d.secondaryButtonBorder));
		prev.style.setProperty("--pv-sec-text",tok("secondaryButtonText",d.secondaryButtonText));
		var chirp='TwitterChirp,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif';
		if(fontOk(ui)){loadFont(ui);prev.style.setProperty("--pv-ui",'"'+ui+'",'+chirp);document.getElementById("fp-ui").style.fontFamily='"'+ui+'",'+chirp}
		else {prev.style.setProperty("--pv-ui",chirp);document.getElementById("fp-ui").style.fontFamily=chirp}
		if(fontOk(display)){loadFont(display);prev.style.setProperty("--pv-display",'"'+display+'",'+chirp);document.getElementById("fp-display").style.fontFamily='"'+display+'",'+chirp}
		else {prev.style.setProperty("--pv-display",chirp);document.getElementById("fp-display").style.fontFamily=chirp}
		ADV.forEach(function(n){if(!flagged(n)&&f[n]&&f[n].type==="color")f[n].value=d[n]||f[n].value});
		f.querySelectorAll("[data-deg]").forEach(function(s){s.textContent=(val(s.getAttribute("data-deg"))||"180")+"°"});
		function worst(fg,bgs){
			var w=Infinity,i;
			for(i=0;i<bgs.length;i++){
				if(!fg||!bgs[i]||String(bgs[i]).indexOf("rgb")===0)continue;
				var c=contrast(fg,bgs[i]);
				if(c<w)w=c;
			}
			return w;
		}
		function setNote(name,text){
			var el=f.querySelector('[data-warn="'+name+'"]');
			if(!el)return;
			if(text){el.hidden=false;el.textContent=text}else{el.hidden=true;el.textContent=""}
		}
		function raiseNote(label,fg,bgs){
			var c=worst(fg,bgs);
			return isFinite(c)&&c<4.5?label+" "+c.toFixed(1)+":1 — will be raised to readable":"";
		}
		setNote("text",raiseNote("Text on background",b.text,b.bg.concat([b.surface])));
		setNote("button",raiseNote("Text on button",b.buttonText,b.button));
		var msgs=[],i;
		function check(label,fg,bgs,min){
			for(i=0;i<bgs.length;i++){
				if(!fg||!bgs[i]||bgs[i].indexOf("rgb")===0)continue;
				var c=contrast(fg,bgs[i]);
				if(c<(min||4.5))msgs.push(label+" on "+bgs[i]+" is "+c.toFixed(2)+":1");
			}
		}
		check("link",tok("link",d.link),b.bg.concat([b.surface]));
		check("muted",tok("muted",d.muted),b.bg.concat([b.surface]),3);
		if(warn){warn.textContent="";msgs.forEach(function(m){var p=document.createElement("p");p.textContent=m;warn.appendChild(p)})}
	}
	function addStop(name,max){
		var row=f.querySelector('[data-stops="'+name+'"]');
		if(!row||row.querySelectorAll("input[type=color]").length>=max)return;
		var n=row.querySelectorAll("input[type=color]").length+1;
		var inp=document.createElement("input");
		inp.type="color";inp.name=name;inp.value="#1d9bf0";
		inp.setAttribute("aria-label","Stop "+n);
		row.appendChild(inp);
		draw();
	}
	function dropStop(name){
		var row=f.querySelector('[data-stops="'+name+'"]');
		var ins=row&&row.querySelectorAll("input[type=color]");
		if(!ins||ins.length<=1)return;
		var last=ins[ins.length-1],wrap=last.parentElement;
		if(wrap&&wrap!==row&&wrap.tagName==="LABEL")wrap.remove();
		else last.remove();
		draw();
	}
	f.addEventListener("input",function(e){
		var t=e.target;
		if(t&&t.getAttribute&&t.getAttribute("data-adv"))flag(t.getAttribute("data-adv"),true);
		draw();
	});
	f.addEventListener("change",draw);
	f.querySelectorAll("[data-add]").forEach(function(b){b.addEventListener("click",function(){addStop(b.getAttribute("data-add"),5)})});
	f.querySelectorAll("[data-drop]").forEach(function(b){b.addEventListener("click",function(){dropStop(b.getAttribute("data-drop"))})});
	f.querySelectorAll("[data-gtoggle]").forEach(function(b){b.addEventListener("click",function(){
		var n=b.getAttribute("data-gtoggle"),on=b.getAttribute("aria-pressed")!=="true";
		b.setAttribute("aria-pressed",on?"true":"false");
		setv(n+"_grad",on?"1":"");
		if(n!=="surface")flag(n,true);
		var row=f.querySelector('[data-stops="'+n+'_stop"]');
		var ang=f.querySelector('input[name="'+n+'_angle"]');
		if(row)row.hidden=!on;
		if(ang&&ang.parentElement&&ang.parentElement.classList.contains("ang"))ang.parentElement.hidden=!on;
		if(on&&row&&!row.querySelector("input")&&f[n]){
			var inp=document.createElement("input");inp.type="color";inp.name=n+"_stop";inp.value=f[n].value;
			inp.setAttribute("aria-label","Stop 1");
			row.appendChild(inp);
		}
		draw();
	})});
	function hideGrad(n){
		setv(n+"_grad","");
		var tog=f.querySelector('[data-gtoggle="'+n+'"]');
		if(tog)tog.setAttribute("aria-pressed","false");
		var row=f.querySelector('[data-stops="'+n+'_stop"]');
		if(row)row.hidden=true;
		var ang=f.querySelector('input[name="'+n+'_angle"]');
		if(ang&&ang.parentElement&&ang.parentElement.classList.contains("ang"))ang.parentElement.hidden=true;
	}
	f.querySelectorAll("[data-reset]").forEach(function(b){b.addEventListener("click",function(){
		var n=b.getAttribute("data-reset");
		if(n==="font_ui"||n==="font_display"){setv(n,"");draw();return}
		flag(n,false);hideGrad(n);draw();
	})});
	var all=f.querySelector("[data-reset-all]");
	if(all)all.addEventListener("click",function(){
		setv("base","dark");setv("text","#f7f9f9");setv("surface","#1e2732");setv("accent","#1d9bf0");setv("buttonText","#0f1419");
		setv("font_ui","");setv("font_display","");
		ADV.forEach(function(n){flag(n,false);hideGrad(n)});
		hideGrad("surface");hideGrad("accent");
		var bg=f.querySelector('[data-stops="bg"]');
		if(bg){bg.querySelectorAll("input[type=color]").forEach(function(i,n){if(n===0)i.value="#15202b";else i.parentElement.remove()})}
		var btn=f.querySelector('[data-stops="button"]');
		if(btn){btn.querySelectorAll("input[type=color]").forEach(function(i,n){if(n===0)i.value="#eff3f4";else i.parentElement.remove()})}
		setv("bg_angle","180");setv("button_angle","180");
		var dark=f.querySelector('input[name="base"][value="dark"]');if(dark)dark.checked=true;
		draw();
	});
	function csrf(){return (document.cookie.match(/(?:^|;\s*)ct0=([^;]+)/)||[])[1]||""}
	function showErrors(errors){
		var list=document.getElementById("theme-import-errors");
		if(!list)return;
		list.replaceChildren();
		if(errors&&errors.length){var head=document.createElement("li");head.className="head";head.textContent="This theme file was rejected. Nothing was applied.";list.appendChild(head)}
		(errors||[]).forEach(function(error){
			var item=document.createElement("li");
			item.textContent=error.path?error.path+": "+error.message:error.message;
			list.appendChild(item);
		});
	}
	function showWarnings(warnings){
		var box=document.getElementById("theme-import-warnings");
		if(!box)return;
		box.replaceChildren();
		(warnings||[]).forEach(function(w){
			var p=document.createElement("p");
			p.className="dim";
			p.textContent=w;
			box.appendChild(p);
		});
	}
	function showBg(path){
		var img=document.getElementById("bg-preview");
		if(!/^\/media\/\d{1,19}\.(png|gif|webp|jpg)$/.test(path||"")){
			if(img)img.remove();
			return;
		}
		if(!img){
			img=document.createElement("img");
			img.id="bg-preview";
			img.alt="";
			prev.insertBefore(img, prev.firstChild);
		}
		var fit=val("bg_fit")||"cover";
		img.style.objectFit=fit==="contain"?"contain":fit==="tile"?"none":"cover";
		img.src=path;
	}
	function setStops(name, list){
		var row=f.querySelector('[data-stops="'+name+'"]');
		if(!row||!list||!list.length)return;
		row.replaceChildren();
		list.forEach(function(hex,i){
			if(!/^#[0-9a-f]{6}$/.test(hex))return;
			var inp=document.createElement("input");
			inp.type="color";inp.name=name;inp.value=hex;
			inp.setAttribute("aria-label","Stop "+(i+1));
			row.appendChild(inp);
		});
	}
	function applyImported(theme){
		if(!theme||typeof theme!=="object")return;
		if(theme.base==="light"||theme.base==="dark"){
			var radio=f.querySelector('input[name="base"][value="'+theme.base+'"]');
			if(radio)radio.checked=true;
		}
		if(theme.bg&&theme.bg.stops){setStops("bg",theme.bg.stops);setv("bg_angle",String(theme.bg.angle||180))}
		if(theme.button&&theme.button.stops){setStops("button",theme.button.stops);setv("button_angle",String(theme.button.angle||180))}
		["surface","text","accent","buttonText"].forEach(function(name){
			var value=theme[name];
			if(typeof value==="string"&&/^#[0-9a-f]{6}$/.test(value)){setv(name,value);hideGrad(name)}
			else if(value&&value.stops){
				setv(name,value.stops[0]);
				setv(name+"_grad","1");
				var tog=f.querySelector('[data-gtoggle="'+name+'"]');
				if(tog)tog.setAttribute("aria-pressed","true");
				var row=f.querySelector('[data-stops="'+name+'_stop"]');
				if(row){row.hidden=false;row.replaceChildren();value.stops.forEach(function(hex,i){
					if(!/^#[0-9a-f]{6}$/.test(hex))return;
					var inp=document.createElement("input");
					inp.type="color";inp.name=name+"_stop";inp.value=hex;
					inp.setAttribute("aria-label","Stop "+(i+1));
					row.appendChild(inp);
				})}
				setv(name+"_angle",String(value.angle||180));
				var ang=f.querySelector('input[name="'+name+'_angle"]');
				if(ang&&ang.parentElement)ang.parentElement.hidden=false;
			}
		});
		ADV.forEach(function(name){
			var value=theme[name];
			if(typeof value==="string"&&/^#[0-9a-f]{6}$/.test(value)){flag(name,true);setv(name,value);hideGrad(name)}
			else if(value&&value.stops){
				flag(name,true);
				setv(name+"_grad","1");
				setv(name,value.stops[0]);
			}
		});
		setv("font_ui",theme.font&&typeof theme.font.ui==="string"?theme.font.ui:"");
		setv("font_display",theme.font&&typeof theme.font.display==="string"?theme.font.display:"");
		if(theme.background){
			setv("background_on","1");
			setv("background_clear","");
			setv("bg_fit",theme.background.fit||"cover");
			setv("bg_position",theme.background.position||"center");
			setv("bg_dim",String(theme.background.dim||0));
			setv("bg_blur",String(theme.background.blur||0));
		}
		draw();
	}
	var file=document.getElementById("theme-file");
	if(file)file.addEventListener("change",function(){
		var picked=file.files&&file.files[0];
		if(!picked)return;
		if(picked.size>65536){showErrors([{path:"",message:"file is too large"}]);file.value="";return}
		picked.text().then(function(text){
			return fetch("/i/api/xitter/theme/import",{method:"POST",headers:{"x-csrf-token":csrf(),"content-type":"text/plain"},body:text}).then(function(r){return r.json()});
		}).then(function(data){
			if(!data||data.ok===false){showErrors(data&&data.errors);showWarnings([]);return}
			showErrors([]);
			showWarnings(data.warnings);
			applyImported(data.theme);
		}).catch(function(){showErrors([{path:"",message:"import failed"}])});
		file.value="";
	});
	var bgFile=document.getElementById("bg-file");
	if(bgFile)bgFile.addEventListener("change",function(){
		var picked=bgFile.files&&bgFile.files[0];
		if(!picked)return;
		var note=document.getElementById("bg-note");
		if(picked.size>8*1024*1024){if(note)note.textContent="image is too large";bgFile.value="";return}
		if(note)note.textContent="";
		var headers={"x-csrf-token":csrf()};
		fetch("/i/media/upload.json?command=INIT&total_bytes="+picked.size+"&media_type="+encodeURIComponent(picked.type||"image/png")+"&media_category=theme_background",{method:"POST",headers:headers}).then(function(r){return r.json()}).then(function(init){
			if(!init||!init.media_id_string)throw new Error((init&&init.error)||"upload failed");
			var body=new FormData();
			body.set("media",picked);
			return fetch("/i/media/upload.json?command=APPEND&media_id="+init.media_id_string+"&segment_index=0",{method:"POST",headers:headers,body:body}).then(function(){
				return fetch("/i/media/upload.json?command=FINALIZE&media_id="+init.media_id_string,{method:"POST",headers:headers}).then(function(r){return r.json()});
			});
		}).then(function(done){
			if(!done||!done.media_id_string)throw new Error((done&&done.error)||"upload failed");
			setv("background_on","1");
			setv("background_clear","");
			setv("background_media",done.media_id_string);
			if(typeof done.theme_path==="string"){prev.setAttribute("data-bg",done.theme_path);showBg(done.theme_path)}
		}).catch(function(err){if(note)note.textContent=err&&err.message?err.message:"upload failed"});
		bgFile.value="";
	});
	var bgClear=document.getElementById("bg-clear");
	if(bgClear)bgClear.addEventListener("click",function(){
		setv("background_clear","1");
		setv("background_on","");
		setv("background_media","");
		prev.removeAttribute("data-bg");
		showBg("");
	});
	["bg_fit","bg_position","bg_dim","bg_blur"].forEach(function(name){
		var el=f[name];
		if(!el)return;
		el.addEventListener("input",function(){
			if(val("background_clear")!=="1")setv("background_on","1");
			var num=document.querySelector('[data-num="'+name+'"]');
			if(num)num.textContent=el.value;
			showBg(prev.getAttribute("data-bg")||"");
		});
	});
	showBg(prev.getAttribute("data-bg")||"");
	draw();
})();`;

function stopInputs(name: string, g: Gradient) {
	return g.stops.map((s, i) => `<input type="color" name="${name}" value="${s}" aria-label="Stop ${i + 1}">`).join("");
}

function gradRow(label: string, name: string, g: Gradient) {
	return `<div class="grow"><span>${label}</span><div class="gstop" data-stops="${name}">${stopInputs(name, g)}</div><div class="grow-tools"><button type="button" class="secondary tiny" data-add="${name}">+ stop</button><button type="button" class="secondary tiny" data-drop="${name}">− stop</button><label class="ang">Angle<input type="range" name="${name}_angle" min="0" max="360" value="${g.angle}"><span class="deg" data-deg="${name}_angle">${g.angle}°</span></label></div></div>`;
}

function colorRow(label: string, name: string, value: string, set: boolean, reset = true) {
	return `<label class="tok"><span>${label}</span><input type="color" name="${name}" data-adv="${name}" value="${value}"><input type="hidden" name="${name}_set" value="${set ? "1" : ""}">${reset ? `<button type="button" class="secondary x" data-reset="${name}" title="Reset">×</button>` : `<span></span>`}<span></span></label>`;
}

function asGrad(v: Fill, fallback: string): Gradient {
	return typeof v === "object" ? v : { stops: [typeof v === "string" && /^#/.test(v) ? v : fallback], angle: 180 };
}

function fillRow(label: string, name: string, value: Fill, fallback: string, set: boolean, reset: boolean) {
	const g = asGrad(value, fallback);
	const on = typeof value === "object" && value.stops.length > 1;
	const solid = solidOf(typeof value === "string" || typeof value === "object" ? value : fallback);
	return `<div class="tok" data-fill="${name}"><span>${label}</span><input type="color" name="${name}" data-adv="${name}" value="${/^#/.test(solid) ? solid : fallback}"><button type="button" class="secondary g" data-gtoggle="${name}" aria-pressed="${on}" title="Gradient">G</button>${reset ? `<button type="button" class="secondary x" data-reset="${name}" title="Reset">×</button>` : `<span></span>`}<input type="hidden" name="${name}_set" value="${set ? "1" : ""}"><input type="hidden" name="${name}_grad" value="${on ? "1" : ""}"><div class="gstop" data-stops="${name}_stop"${on ? "" : " hidden"}>${stopInputs(`${name}_stop`, g)}</div><label class="ang"${on ? "" : " hidden"}>Angle<input type="range" name="${name}_angle" min="0" max="360" value="${g.angle}"><span class="deg" data-deg="${name}_angle">${g.angle}°</span></label></div>`;
}

function formFill(f: FormData, name: string): unknown {
	if (String(f.get(`${name}_grad`) ?? "") === "1") {
		const stops = f.getAll(`${name}_stop`);
		if (stops.length) return { stops, angle: Number(f.get(`${name}_angle`)) };
	}
	return f.get(name);
}

function fromForm(f: FormData): { clear?: true; theme?: unknown } {
	if (f.has("preset")) {
		const id = String(f.get("preset") ?? "");
		if (!id) return { clear: true };
		return { theme: { id } };
	}
	const theme: Record<string, unknown> = {
		id: "custom",
		base: String(f.get("base") ?? ""),
		bg: { stops: f.getAll("bg"), angle: Number(f.get("bg_angle")) },
		surface: formFill(f, "surface"),
		text: f.get("text"),
		accent: formFill(f, "accent"),
		button: { stops: f.getAll("button"), angle: Number(f.get("button_angle")) },
		buttonText: f.get("buttonText"),
	};
	for (const k of OPTIONAL_HEX) {
		if (String(f.get(`${k}_set`) ?? "") === "1") theme[k] = f.get(k);
	}
	for (const k of OPTIONAL_FILL) {
		if (String(f.get(`${k}_set`) ?? "") === "1") theme[k] = formFill(f, k);
	}
	const ui = validateFamily(String(f.get("font_ui") ?? ""));
	const display = validateFamily(String(f.get("font_display") ?? ""));
	if (ui || display) theme.font = { ...(ui ? { ui } : {}), ...(display ? { display } : {}) };
	if (String(f.get("background_clear") ?? "") === "1") theme.background = null;
	else if (String(f.get("background_on") ?? "") === "1") {
		const background: Record<string, unknown> = {
			fit: String(f.get("bg_fit") ?? "cover"),
			position: String(f.get("bg_position") ?? "center"),
			dim: Number(f.get("bg_dim") ?? 0),
			blur: Number(f.get("bg_blur") ?? 0),
		};
		const mediaId = String(f.get("background_media") ?? "");
		if (mediaId) background.mediaId = mediaId;
		theme.background = background;
	}
	return { theme };
}

async function keepOwnedBackground(userId: string, theme: Theme, warnings: string[]): Promise<Theme> {
	const id = theme.background?.mediaId;
	if (!id) return theme;
	const { ownedThemePhoto } = await import("./media");
	const owned = await ownedThemePhoto(userId, id);
	if (owned) return theme;
	warnings.push("that background image isn't on this account");
	const next = copyTheme(theme);
	next.background = { fit: theme.background!.fit, position: theme.background!.position, dim: theme.background!.dim, blur: theme.background!.blur };
	return next;
}

async function commitLook(
	userId: string,
	current: Prefs,
	write: LookWrite,
	accent: Accent | undefined,
	warnings: readonly string[] = [],
): Promise<{ look: Look | null; accent: Accent; warnings: readonly string[] }> {
	const nextWarnings = [...warnings];
	let next = write;
	if (write.type === "paint") {
		const stored = current.look?.kind === "painted" ? current.look.theme : undefined;
		let theme = mergeSavedBackground(stored, write.theme, write.peel, write.mediaIdSent);
		theme = await keepOwnedBackground(userId, theme, nextWarnings);
		if (theme.font) {
			const prep = await prepareFonts(theme.font);
			nextWarnings.push(...prep.warnings);
			if (prep.font.ui || prep.font.display) theme = { ...theme, font: prep.font };
			else {
				theme = { ...theme };
				delete theme.font;
			}
		}
		next = { type: "paint", theme, peel: write.peel, mediaIdSent: write.mediaIdSent };
	}
	const nextAccent = accent ?? current.accent;
	const look = overlayAccent(applyWrite(current.look, next), nextAccent);
	await saveLook(userId, look, nextAccent);
	return { look, accent: nextAccent, warnings: nextWarnings };
}

async function saveLook(userId: string, look: Look | null, accent: Accent): Promise<void> {
	const { sql } = await import("./db");
	const patch =
		look?.kind === "native"
			? { mode: look.mode, accent: accentWire(accent) }
			: look?.kind === "painted"
				? { theme: look.theme, accent: accentWire(accent) }
				: { accent: accentWire(accent) };
	await sql`update users set preferences = (coalesce(preferences, '{}') - 'theme' - 'mode' - 'accent') || ${JSON.stringify(patch)}::text::jsonb where id = ${userId}::bigint`;
}

export async function loadPrefs(userId: string): Promise<Prefs> {
	const { sql } = await import("./db");
	const [row] = await sql`select preferences from users where id = ${userId}::bigint`;
	return readPrefs(row?.preferences);
}

export async function loadLook(userId: string): Promise<Look | null> {
	return (await loadPrefs(userId)).look;
}

function swatchStyle(g: Gradient) {
	return `background:${fillCss(g)}`;
}

async function themePage(req: Request, viewer: Viewer, current: Theme | null, notices: { error?: string; warnings?: string[] } = {}) {
	const { accountPage, esc } = await import("./account-page");
	const form = (fields: string, extra = "") =>
		`<form method="post" action="/account/theme" ${extra}><input type="hidden" name="csrf" value="${esc(viewer.csrf)}">${fields}</form>`;
	const pick = (id: string, name: string, g: Gradient, on: boolean) =>
		`<button type="submit" name="preset" value="${esc(id)}" class="pick${on ? " on" : ""}"><span class="swatch" style="${swatchStyle(g)}"></span><span class="name">${esc(name)}</span></button>`;
	const colors = current ?? PRESETS.dim!;
	const d = derived(colors);
	const hex = (v: string) => (/^#[0-9a-f]{6}$/i.test(v) ? v : solidOf(colors.surface));
	const set = (k: keyof Theme) => current != null && current[k] != null;
	const opt = (label: string, name: keyof Theme, fallback: string) =>
		colorRow(label, name, hex(typeof colors[name] === "string" ? (colors[name] as string) : fallback), set(name));
	const fonts = FONT_SUGGESTIONS.map((n) => `<option value="${esc(n)}">`).join("");
	const bg = current?.background;
	const ownedBg = bg?.mediaId ? await resolveBackground(viewer.id, current!) : undefined;
	const bgPath = ownedBg && /^\/media\/\d{1,19}\.(?:png|gif|webp|jpg)$/.test(ownedBg.image) ? ownedBg.image : "";
	const body = `<h1>Theme</h1>
	<p class="dim">X dropped Dim; this puts it back, and lets you pick a look of your own. Dark themes sit on Lights out, light ones on Default. A typeface rides with a theme — Default / Lights out is X's own and has no custom font. Organisation profile decor keeps its own colours on the profile column.</p>
	${notices.error ? `<p class="error">${esc(notices.error)}</p>` : ""}
	${(notices.warnings ?? []).map((w) => `<p class="dim">${esc(w)}</p>`).join("")}
	<h2>Share</h2>
	<p class="share"><a class="secondary" href="/i/api/xitter/theme/export">Export theme</a><label class="secondary file">Import theme<input type="file" id="theme-file" accept="application/json,.json"></label></p>
	<ul id="theme-import-errors"></ul>
	<div id="theme-import-warnings"></div>
	<h2>Looks</h2>
	${form(
		`${pick("", "Default / Lights out (X's own)", { stops: ["#000000", "#ffffff"], angle: 90 }, !current)}
		${pick("dim", "Dim", PRESETS.dim!.bg, current?.id === "dim")}
		${SWATCH_IDS.map((id) => pick(id, PRESET_NAMES[id]!, PRESETS[id]!.bg, current?.id === id)).join("")}`,
		'class="swatches"',
	)}
	<h2>Custom</h2>
	${form(
		`<div class="row">
			<label class="choice"><input type="radio" name="base" value="dark"${colors.base !== "light" ? " checked" : ""}>Dark</label>
			<label class="choice"><input type="radio" name="base" value="light"${colors.base === "light" ? " checked" : ""}>Light</label>
		</div>
		<div class="live" id="preview" data-bg="${esc(bgPath)}">
			<div class="stage">
				<div class="nav"><span class="on">Home</span>Search<br>Profile</div>
				<div class="feed">
					<div class="cardp"><div class="ava"></div><div><div class="who"><b>Ada</b> <span>@ada</span></div><p class="body">A sample post with a <a class="lk" href="#">link</a> and <a class="lk" href="#">@mention</a>.</p><div class="acts"><span class="r">↩</span><span class="t">↻</span><span class="h">♥</span><span class="b">⚑</span><span class="v">12</span></div><span class="badge">2</span></div></div>
				</div>
				<div class="side"><input class="search" value="Search" readonly><div class="menu">A menu</div><button type="button" class="pill">Post</button><button type="button" class="ghost">Follow</button></div>
			</div>
		</div>
		${gradRow("Background", "bg", colors.bg)}
		<div class="toks">
			${fillRow("Surface", "surface", colors.surface, "#1e2732", true, false)}
			${colorRow("Text", "text", colors.text, true, false)}
			${fillRow("Accent / links", "accent", colors.accent, "#1d9bf0", true, false)}
			${colorRow("Button text", "buttonText", colors.buttonText, true, false)}
		</div>
		<p class="note" data-warn="text" hidden></p>
		${gradRow("Primary button", "button", colors.button)}
		<p class="note" data-warn="button" hidden></p>
		<div class="fonts">
			<p class="h3">Font</p>
			<div class="fg">
				<span>Text font</span>
				<div class="line">
					<input type="text" name="font_ui" list="font-ui" value="${esc(colors.font?.ui ?? "")}" placeholder="Chirp" maxlength="40" autocomplete="off">
					<button type="button" class="small secondary" data-reset="font_ui">Default</button>
				</div>
				<datalist id="font-ui">${fonts}</datalist>
				<p class="fp" id="fp-ui">The quick brown fox posts on Xitter</p>
			</div>
			<div class="fg">
				<span>Display names &amp; headings</span>
				<div class="line">
					<input type="text" name="font_display" list="font-display" value="${esc(colors.font?.display ?? "")}" placeholder="Same as text font" maxlength="40" autocomplete="off">
					<button type="button" class="small secondary" data-reset="font_display">Default</button>
				</div>
				<datalist id="font-display">${fonts}</datalist>
				<p class="fp" id="fp-display">Ada Lovelace</p>
			</div>
		</div>
		<details class="adv"><summary>Advanced</summary>
			<p class="h3">Text</p>
			<div class="toks">
				${opt("Secondary text", "secondary", d.secondary)}
				${opt("Muted text", "muted", d.muted)}
				${opt("Link colour", "link", d.link)}
			</div>
			<p class="h3">Lines</p>
			<div class="toks">
				${opt("Borders", "border", d.border)}
				${opt("Dividers", "divider", d.divider)}
			</div>
			<p class="h3">Surfaces</p>
			<div class="toks">
				${opt("Hover", "hover", /^#/.test(d.hover) ? d.hover : colors.text)}
				${opt("Input background", "inputBg", d.inputBg)}
				${opt("Input text", "inputText", d.inputText)}
				${opt("Input border", "inputBorder", d.inputBorder)}
				${fillRow("Header", "header", colors.header ?? d.header, hex(d.header), set("header"), true)}
				${fillRow("Menus", "menu", colors.menu ?? d.menu, hex(d.menu), set("menu"), true)}
				${opt("Tooltips", "tooltip", d.tooltip)}
			</div>
			<p class="h3">Icons</p>
			<div class="toks">
				${opt("Icons", "icon", d.icon)}
				${opt("Active nav icon", "iconActive", d.iconActive)}
			</div>
			<p class="h3">Actions</p>
			<div class="toks">
				${opt("Reply", "reply", d.reply)}
				${opt("Repost", "repost", d.repost)}
				${opt("Like", "like", d.like)}
				${opt("Bookmark / share", "bookmark", d.bookmark)}
				${opt("Views", "views", d.views)}
			</div>
			<p class="h3">Buttons</p>
			<div class="toks">
				${fillRow("Secondary button", "secondaryButton", colors.secondaryButton ?? (d.secondaryButton === "transparent" ? solidOf(colors.surface) : d.secondaryButton), solidOf(colors.surface), set("secondaryButton"), true)}
				${opt("Secondary border", "secondaryButtonBorder", d.secondaryButtonBorder)}
				${opt("Secondary text", "secondaryButtonText", d.secondaryButtonText)}
				${opt("Primary hover", "buttonHover", d.buttonHover)}
			</div>
			<p class="h3">Badges &amp; misc</p>
			<div class="toks">
				${opt("Notification badge", "badge", d.badge)}
				${opt("Selection", "selection", /^#/.test(d.selection) ? d.selection : solidOf(colors.accent))}
			</div>
			<div class="warns" id="warns"></div>
		</details>
		<div class="bgopt">
			<p class="h3">Background image</p>
			<p class="dim">The picture is not in an exported file. Upload it here, then save.</p>
			<input type="hidden" name="background_on" value="${bg ? "1" : ""}">
			<input type="hidden" name="background_clear" value="">
			<input type="hidden" name="background_media" value="${esc(bg?.mediaId ?? "")}">
			<div class="line">
				<label>Fit<select name="bg_fit"><option value="cover"${!bg || bg.fit === "cover" ? " selected" : ""}>Cover</option><option value="contain"${bg?.fit === "contain" ? " selected" : ""}>Contain</option><option value="tile"${bg?.fit === "tile" ? " selected" : ""}>Tile</option></select></label>
				<label>Position<select name="bg_position"><option value="center"${!bg || bg.position === "center" ? " selected" : ""}>Center</option><option value="top"${bg?.position === "top" ? " selected" : ""}>Top</option><option value="bottom"${bg?.position === "bottom" ? " selected" : ""}>Bottom</option></select></label>
			</div>
			<label class="ang">Dim<input type="range" name="bg_dim" min="0" max="80" value="${bg?.dim ?? 0}"><span class="deg" data-num="bg_dim">${bg?.dim ?? 0}</span></label>
			<label class="ang">Blur<input type="range" name="bg_blur" min="0" max="20" value="${bg?.blur ?? 0}"><span class="deg" data-num="bg_blur">${bg?.blur ?? 0}</span></label>
			<div class="line">
				<label class="secondary file">Upload image<input type="file" id="bg-file" accept="image/png,image/gif,image/webp,image/jpeg"></label>
				<button type="button" class="secondary" id="bg-clear">Remove image</button>
			</div>
			<p class="dim" id="bg-note"></p>
		</div>
		<div class="savebar">
			<button type="submit">Save theme</button>
			<button type="submit">Apply</button>
			<button type="button" class="secondary" data-reset-all>Reset all</button>
		</div>`,
		'id="custom" class="editor"',
	)}
	<script>${EDITOR_SCRIPT}</script>`;
	const head = fontLinks(current);
	return accountPage({ req, viewer, title: "Theme", status: notices.error ? 400 : 200, body, css: PAGE_CSS, head });
}

export async function themeRoute(req: Request, viewer: Viewer): Promise<Response> {
	const current = await loadPrefs(viewer.id);
	const theme = current.look?.kind === "painted" ? current.look.theme : null;
	if (req.method !== "POST") return themePage(req, viewer, theme);
	const f = await req.formData().catch(() => undefined);
	if (String(f?.get("csrf") ?? "") !== viewer.csrf) return themePage(req, viewer, theme, { error: "That form is out of date. Try again." });
	const parsed = parseLookWrite(fromForm(f!));
	if (!parsed.ok) return themePage(req, viewer, theme, { error: "That isn't a theme." });
	const saved = await commitLook(viewer.id, current, parsed.write, parsed.accent, parsed.warnings);
	const headers = new Headers({ location: "/account/theme" });
	for (const c of nightModeCookies(saved.look)) headers.append("set-cookie", c);
	return new Response(null, { status: 303, headers });
}

export async function themeApi(req: Request, viewer: Viewer): Promise<Response> {
	if (req.method === "GET") {
		const prefs = await loadPrefs(viewer.id);
		return Response.json(lookView(prefs.look, prefs.accent));
	}
	if (req.method !== "POST") return Response.json({ error: "use GET or POST" }, { status: 405 });
	const body = await req.json().catch(() => null);
	const current = await loadPrefs(viewer.id);
	const parsed = parseLookWrite(body);
	if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
	const saved = await commitLook(viewer.id, current, parsed.write, parsed.accent, parsed.warnings);
	const headers = new Headers();
	for (const c of nightModeCookies(saved.look)) headers.append("set-cookie", c);
	const view = lookView(saved.look, saved.accent);
	if (parsed.write.type === "paint" || saved.warnings.length) return Response.json({ ...view, warnings: saved.warnings }, { headers });
	return Response.json(view, { headers });
}

