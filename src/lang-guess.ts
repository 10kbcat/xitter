const SCRIPTS: [RegExp, (t: string) => string][] = [
	[/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/gu, (t) => (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(t) ? "ja" : "zh")],
	[/\p{Script=Hangul}/gu, () => "ko"],
	[/\p{Script=Cyrillic}/gu, (t) => (/[іїєґІЇЄҐ]/.test(t) ? "uk" : "ru")],
	[/\p{Script=Arabic}/gu, (t) => (/[پچژگ]/.test(t) ? "fa" : "ar")],
	[/\p{Script=Hebrew}/gu, () => "he"],
	[/\p{Script=Thai}/gu, () => "th"],
	[/\p{Script=Greek}/gu, () => "el"],
	[/\p{Script=Devanagari}/gu, () => "hi"],
	[/\p{Script=Bengali}/gu, () => "bn"],
	[/\p{Script=Tamil}/gu, () => "ta"],
	[/\p{Script=Georgian}/gu, () => "ka"],
	[/\p{Script=Armenian}/gu, () => "hy"],
];

const WORDS: Record<string, string> = {
	en: "the and is are you that this with for have was not but what it's i'm my your of to in it be just so they we",
	es: "el los las que y es por para con una pero muy más está como del lo se yo tu hay también porque cuando",
	pt: "os que e é não um uma para com mas muito está você do da eu meu também isso quando porque",
	fr: "le les des et est une un pas que pour avec je tu il elle c'est du au mais très sur dans ce qui",
	de: "der die das und ist nicht ich du ein eine mit auf für aber sehr auch wie zu es sie wir den dem",
	it: "il lo gli che di e è non per con una un ma molto sono anche come del della io questo",
	nl: "de het een en is niet ik je van dat met op voor maar ook zijn wat heel",
	tr: "ve bir bu için ile çok ne ben sen değil var yok gibi ama",
	id: "dan yang di ini itu tidak aku saya kamu dengan untuk ada juga sudah akan bisa",
	pl: "i w nie się jest na to że z do jak ale tak co ja ty bardzo",
	sv: "och är att det som en på inte jag du med för men har den av",
};
const WORD_SETS = Object.entries(WORDS).map(([lang, w]) => [lang, new Set(w.split(" "))] as const);
const MARKS: [RegExp, string][] = [
	[/[ñ¿¡]/, "es"],
	[/[ãõ]/, "pt"],
	[/[ß]/, "de"],
	[/[ğşı]/, "tr"],
	[/[ąęłśżźćń]/, "pl"],
	[/[å]/, "sv"],
	[/[œ]/, "fr"],
];

export function guessLang(input: string): string {
	const text = input.slice(0, 600).replace(/https?:\/\/\S+|[@#][\p{L}\p{N}_.@-]+/gu, " ");
	const letters = text.match(/\p{L}/gu)?.length ?? 0;
	if (!letters) return "und";
	for (const [re, lang] of SCRIPTS) if ((text.match(re)?.length ?? 0) * 2 >= letters) return lang(text);
	const latin = text.match(/\p{Script=Latin}/gu)?.length ?? 0;
	if (latin * 2 < letters) return "und";
	const lower = text.toLowerCase().replaceAll("\u2019", "'");
	const words = lower.match(/[\p{L}']+/gu) ?? [];
	const scores = WORD_SETS.map(([lang, set]) => [lang, words.reduce((n, w) => n + (set.has(w) ? 1 : 0), 0) + MARKS.reduce((n, [re, l]) => n + (l === lang && re.test(lower) ? 2 : 0), 0)] as const).sort((a, b) => b[1] - a[1]);
	const [[best, top], [, next]] = scores;
	return top >= 2 && top > next ? best : "und";
}
