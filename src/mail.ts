// Outgoing mail through Resend. The key is send-only, so this is the one call we make.
const KEY = process.env.RESEND_API_KEY;
const FROM = process.env.MAIL_FROM ?? "Xitter <noreply@xit.chococat.lol>";

export const mailEnabled = () => !!KEY;

export async function sendMail(to: string, subject: string, text: string): Promise<void> {
	if (!KEY) throw new Error("mail isn't configured (RESEND_API_KEY)");
	const r = await fetch("https://api.resend.com/emails", {
		method: "POST",
		headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
		body: JSON.stringify({ from: FROM, to: [to], subject, text }),
	});
	if (!r.ok) throw new Error(`Resend ${r.status}: ${(await r.text()).slice(0, 300)}`);
}
