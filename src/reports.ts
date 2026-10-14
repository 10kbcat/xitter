// Reporting: the client's "Report post" / "Report account" screens run X's
// step-by-step task flow against POST /1.1/report/flow.json. We answer with our
// own steps (a reason, optional details, a thank-you) and file a report for
// staff. The flow's state lives here between steps, keyed by its flow token.

import type { Viewer } from "./auth";
import { sql } from "./db";
import { isId, newId } from "./ids";

export const REASONS: Record<string, { text: string; subtext: string }> = {
	spam: { text: "Spam", subtext: "Fake engagement, scams, misleading links, repetitive posts" },
	harassment: { text: "Harassment or bullying", subtext: "Insults, threats, targeting someone, unwanted attention" },
	hate: { text: "Hate", subtext: "Attacking people for who they are" },
	violence: { text: "Violence", subtext: "Threats, glorifying or encouraging violence" },
	self_harm: { text: "Self-harm", subtext: "Encouraging suicide or self-harm" },
	sensitive: { text: "Sensitive or graphic media", subtext: "Adult content or gore that isn't marked" },
	impersonation: { text: "Impersonation", subtext: "Pretending to be someone else" },
	private_info: { text: "Private information", subtext: "Sharing someone's address, phone or photos without consent" },
	other: { text: "Something else", subtext: "Tell us in the next step" },
};

type Draft = { reporter: string; postId: string | null; userId: string | null; reason?: string; at: number };
const drafts = new Map<string, Draft>();
const DRAFT_MS = 60 * 60 * 1000;

const text = (t: string) => ({ text: t, entities: [] });
const link = (type: string, id: string, label?: string) => ({ link_type: type, link_id: id, ...(label ? { label } : {}) });

const flow = (token: string, subtask: object) => ({ flow_token: token, status: "success", subtasks: [subtask] });

const reasonStep = (what: string) => ({
	subtask_id: "report_reason",
	choice_selection: {
		primary_text: text(`What's wrong with this ${what}?`),
		secondary_text: text("Staff of this instance will look at your report."),
		choices: Object.entries(REASONS).map(([id, r]) => ({ id, text: text(r.text), subtext: text(r.subtext) })),
		selection_type: "single_select",
		next_link: link("task", "next_link", "Next"),
		skip_link: link("abort_flow", "cancel", "Cancel"),
	},
});

const detailsStep = () => ({
	subtask_id: "report_details",
	enter_text: {
		primary_text: text("Anything else staff should know?"),
		secondary_text: text("Optional. Links, context, or what happened."),
		hint_text: "Details",
		multiline: true,
		max_length: 1000,
		next_link: link("task", "next_link", "Send report"),
		skip_link: link("task", "skip_link", "Send without details"),
	},
});

const doneStep = () => ({
	subtask_id: "report_done",
	cta: {
		primary_text: text("Thanks for letting us know"),
		secondary_text: text("Your report went to this instance's staff. You can also block or mute the account from its profile."),
		primary_action_link: link("finish_flow", "done", "Done"),
	},
});

// the reported post or account, from the flow's start request
function target(body: any): { postId: string | null; userId: string | null } {
	let v: any = body?.input_flow_data?.requested_variant;
	if (typeof v === "string") {
		try {
			v = JSON.parse(v);
		} catch {
			v = {};
		}
	}
	const postId = [v?.reported_tweet_id, v?.tweet_id].find(isId) ?? null;
	const userId = [v?.reported_user_id, v?.user_id].find(isId) ?? null;
	return { postId, userId };
}

export async function reportFlow(viewer: Viewer, url: URL, body: any): Promise<Response> {
	const now = Date.now();
	for (const [k, d] of drafts) if (now - d.at > DRAFT_MS) drafts.delete(k);

	// a new flow
	if (url.searchParams.get("flow_name") || !body?.flow_token) {
		let { postId, userId } = target(body);
		if (postId && !userId) {
			const [p] = await sql`select user_id::text as user_id from posts where id = ${postId}::bigint`;
			userId = p?.user_id ?? null;
		}
		const token = `report:${newId()}`;
		drafts.set(token, { reporter: viewer.id, postId, userId, at: now });
		return Response.json(flow(token, reasonStep(postId ? "post" : "account")));
	}

	const token = String(body.flow_token);
	const draft = drafts.get(token);
	if (!draft || draft.reporter !== viewer.id) return Response.json({ errors: [{ code: 366, message: "This report expired. Please start again." }] }, { status: 400 });
	draft.at = now;
	const inputs: any[] = Array.isArray(body.subtask_inputs) ? body.subtask_inputs : [];
	const reason = inputs.find((i) => i.subtask_id === "report_reason")?.choice_selection?.selected_choices?.[0];
	if (reason && REASONS[reason]) {
		draft.reason = reason;
		return Response.json(flow(token, detailsStep()));
	}
	const details = inputs.find((i) => i.subtask_id === "report_details")?.enter_text;
	if (details && draft.reason) {
		const textIn = details.link === "skip_link" ? "" : String(details.text ?? "").slice(0, 1000);
		await sql`insert into reports (id, reporter_id, post_id, user_id, reason, details)
			values (${newId()}::bigint, ${viewer.id}::bigint, ${draft.postId}::bigint, ${draft.userId}::bigint, ${draft.reason}, ${textIn})`;
		drafts.delete(token);
		return Response.json(flow(token, doneStep()));
	}
	return Response.json(flow(token, reasonStep(draft.postId ? "post" : "account")));
}
