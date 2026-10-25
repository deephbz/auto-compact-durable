// The keepset method, adapted from Pi's Auto Compact (packages/hc-auto-compact/src/methods). The model answers one
// planning request with {summary, keep}: its working-state summary and the labels of the tool outputs it still needs
// verbatim. The planning request is the conversation's last real request plus one appended user message, so the
// provider serves the whole prefix from its cache. The host captures that request (CapturedRequest); this module
// builds the manifest, the prompt, the plan check, and the kept-output text. Durable keeps placement and custody.

import type { AssistantMessage, Message, Model, StreamOptions, Tool } from "@earendil-works/pi-ai";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { estimateMessageTokens, estimateTextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { createInitialSystemMessage, getCurrentSystemMessage } from "@earendil-works/pi-ai/utils/transcript";

const estimate = (text: string): number => Math.ceil(text.length / 4);

/**
 * Option key that marks a planning request. The host's cache layer places the captured request's marks on the first
 * `prefixMessages` provider messages and leaves the appended messages unmarked, and it does not capture the request.
 */
export const PLANNER_REQUEST = Symbol.for("hypercarrier.compact.planner");
export type PlannerMark = { prefixMessages?: number };

/** The last real request of a conversation, as the host's Models wrapper saw it. */
export type CapturedRequest = {
	model: Model<never>;
	context: { systemPrompt?: string; messages: readonly Message[]; tools?: readonly Tool[] };
	options: StreamOptions;
	/** Provider messages in the sent payload, when the provider exposes its payload. */
	prefixMessages?: number;
	at: number;
};

export const PLAN_KEYS = { perItemTokens: 8_000 } as const;

/** Kept tool outputs share min(20000, W/4) tokens, the Pi Auto Compact default. */
export const keepCap = (workingBudget: number | undefined): number =>
	Math.max(0, Math.min(20_000, workingBudget ? Math.floor(workingBudget / 4) : 20_000));

export type Round = {
	label: string;
	name: string;
	args: unknown;
	resultText: string;
	isError: boolean;
	tokens: number;
	/** Tokens of this output's installed block (header, fence, body, cut mark); the keep cap counts these. */
	keptTokens: number;
	callEntryId: string;
	resultEntryId?: string;
	superseded?: boolean;
};

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block: { type?: string; text?: string }) => (block?.type === "text" ? (block.text ?? "") : block?.type === "image" ? "[image]" : ""))
		.filter(Boolean)
		.join("\n");
}

const oneLine = (value: string, max: number) => {
	const s = value.replace(/\s+/g, " ").trim();
	return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

/** One labelled round per tool call in the replaced entries, in order (Pi collectToolRounds, markSuperseded). */
export function collectRounds(entries: readonly EntryRecord[]): Round[] {
	const rounds: Round[] = [];
	const byCall = new Map<string, Round>();
	for (const entry of entries) {
		// biome-ignore lint: loosely typed pi-ai message
		const m = entry.model?.[0] as any;
		if (entry.kind === "pi.assistant") {
			for (const block of (m?.content ?? []) as { type?: string; id?: string; name?: string; arguments?: unknown }[]) {
				if (block?.type !== "toolCall") continue;
				const round: Round = { label: `t${rounds.length + 1}`, name: String(block.name), args: block.arguments ?? {}, resultText: "", isError: false, tokens: 0, keptTokens: 0, callEntryId: String(entry.id) };
				rounds.push(round);
				byCall.set(String(block.id), round);
			}
		} else if (entry.kind === "pi.tool-result") {
			const round = byCall.get(String(m?.toolCallId));
			if (!round) continue;
			round.resultText = textOf(m?.content);
			round.isError = m?.isError === true;
			round.resultEntryId = String(entry.id);
		}
	}
	const lastWrite = new Map<string, number>();
	rounds.forEach((round, i) => {
		const path = (round.args as { path?: string; file_path?: string })?.path ?? (round.args as { file_path?: string })?.file_path;
		round.tokens = estimate(round.resultText) + estimate(JSON.stringify(round.args));
		round.keptTokens = keptBlock(round).tokens;
		if (path && (round.name === "write" || round.name === "edit")) lastWrite.set(path, i);
	});
	rounds.forEach((round, i) => {
		const path = (round.args as { path?: string })?.path ?? (round.args as { file_path?: string })?.file_path;
		round.superseded = round.name === "read" && !!path && (lastWrite.get(path) ?? -1) > i;
	});
	return rounds;
}

export function renderManifest(rounds: readonly Round[], budgetTokens: number): string {
	return [
		`Keep budget: ${budgetTokens} tokens in total.`,
		"label | tool | arguments | size | flags",
		...rounds.map((round) => {
			const flags = [round.isError ? "error" : "", round.superseded ? "superseded" : ""].filter(Boolean).join(",");
			// The size is what keeping the output costs: its installed block, cut included.
			const size = round.keptTokens >= 1000 ? `${(round.keptTokens / 1000).toFixed(1)}k` : `${round.keptTokens}`;
			return `${round.label} | ${round.name} | ${oneLine(JSON.stringify(round.args), 100)} | ${size} tok${flags ? ` | ${flags}` : ""}`;
		}),
	].join("\n");
}

export const PLAN_PROMPT_PREFIX = "This is a compaction step.";

/** Pi's background planning prompt, with durable's verbatim tail and the plan rules this port enforces. */
export function planPrompt(rounds: readonly Round[], options: { budgetTokens: number; keptFrom?: string; instructions?: string }): string {
	return [
		`${PLAN_PROMPT_PREFIX} Do not continue the task and do not call tools. ${options.keptFrom ? `The compaction replaces the conversation before this message, which stays verbatim with everything after it: ${options.keptFrom}` : "The compaction replaces the conversation before your most recent messages, which stay verbatim."}`,
		"Write the summary for yourself after compaction. Preserve the essential goals, constraints, decisions, verified results, open questions and next action. Compaction also keeps the user's recent messages and your recent prose within a budget, and the kept tool outputs; avoid long quotations of them. It does not keep messages that extensions delivered, such as task, team, or alert notices. Write what you still need from them into the summary. If a tool can read some content again, write only the tool and the ID that reads it. Dropped tool outputs leave the context; to see one again, repeat a read-only call. Never replay a mutating call to recover its output.",
		`Return only JSON text with the keys "summary" (nonempty string) and "keep" (array of labels). Keep lists the labels of tool outputs you still need verbatim, most important first. Each kept output costs the size listed below, at most ${PLAN_KEYS.perItemTokens} tokens; a longer output is cut there. A plan that names a label not in the list below, or whose kept outputs exceed the keep budget, is rejected.`,
		...(options.instructions ? [`The user asked this compaction to focus on: ${options.instructions}`] : []),
		renderManifest(rounds, options.budgetTokens),
	].join("\n");
}

export type Plan = { summary: string; keep: string[] };

/** The plan from the planner's reply: one complete JSON object, bare or in one JSON fence. Null: the model called a tool. */
export function readPlan(message: AssistantMessage): Plan | null {
	const content = Array.isArray(message.content) ? message.content : [];
	if (content.some((block) => block?.type === "toolCall")) return null;
	const text = content.filter((block) => block?.type === "text").map((block) => (block as { text: string }).text).join("\n").trim();
	const fence = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/.exec(text);
	let parsed: { summary?: unknown; keep?: unknown };
	try {
		parsed = JSON.parse(fence ? fence[1]! : text);
	} catch {
		throw new PlanRejected("the plan is not complete JSON");
	}
	if (!parsed || typeof parsed.summary !== "string" || !parsed.summary.trim()) throw new PlanRejected("the plan has an empty summary");
	if (!Array.isArray(parsed.keep) || !parsed.keep.every((label) => typeof label === "string")) throw new PlanRejected("keep is not a list of labels");
	return { summary: parsed.summary, keep: parsed.keep as string[] };
}

/** A plan the hook does not install; the reason goes to the record. */
export class PlanRejected extends Error {}

export type Resolved = { kept: Round[]; dropped: Round[]; tokens: number };

/**
 * Check the plan against the manifest and the cap. Repeated labels count once. The cap counts the installed text
 * (renderKept), so fences and headers cannot push it over; the decision depends only on the plan and the entries.
 */
export function resolveKeep(rounds: readonly Round[], keep: readonly string[], budgetTokens: number): Resolved {
	const byLabel = new Map(rounds.map((round) => [round.label, round]));
	const kept = new Set<Round>();
	for (const raw of keep) {
		const round = byLabel.get(raw.trim());
		if (!round) throw new PlanRejected(`keep named an unknown entry (${oneLine(raw, 20)})`);
		kept.add(round);
	}
	const ordered = rounds.filter((round) => kept.has(round));
	const tokens = ordered.length ? estimate(renderKept(ordered)) : 0;
	if (tokens > budgetTokens) throw new PlanRejected(`kept outputs need ${tokens} tokens, over the ${budgetTokens}-token cap`);
	return { kept: ordered, dropped: rounds.filter((round) => !kept.has(round)), tokens };
}

// A fence longer than any backtick run in the body keeps embedded fences inside it.
const fence = (text: string) => "`".repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((m) => m[0].length + 1)));

/**
 * One kept output as installed: header, fenced body and cut mark, at most PLAN_KEYS.perItemTokens tokens in total.
 * The body is byte-equal to history up to the cut. A long backtick run lengthens the fence, so the cut is measured on
 * the rendered block.
 */
export function keptBlock(round: Round): { text: string; tokens: number; cut: boolean } {
	const max = PLAN_KEYS.perItemTokens * 4;
	const header = `### ${round.label} · ${round.name} ${oneLine(JSON.stringify(round.args), 200)}${round.isError ? " (error)" : ""}`;
	const render = (body: string) => {
		const marker = fence(body);
		const cut = body.length < round.resultText.length;
		return `${header}\n${marker}\n${body}\n${marker}${cut ? `\n[cut at ${PLAN_KEYS.perItemTokens} tokens; ${estimate(round.resultText) - estimate(body)} more tokens in history]` : ""}`;
	};
	let body = round.resultText;
	let text = render(body);
	// Shrink in proportion to the overshoot: a fence that grows with the body converges as fast as plain text.
	for (let i = 0; text.length > max && body.length > 0 && i < 32; i++) {
		body = body.slice(0, Math.min(body.length - 1, Math.floor((body.length * max) / text.length)));
		text = render(body);
	}
	if (text.length > max) text = render((body = ""));
	return { text, tokens: estimate(text), cut: body.length < round.resultText.length };
}

export function renderKept(kept: readonly Round[]): string {
	return kept.map((round) => keptBlock(round).text).join("\n\n");
}

/*
 * The fit check is an estimate at hook time; durable's placement owns the installed context. It uses pi-ai's estimator
 * on what pi-ai sends: 3.5 characters per token, a system message as its rendered sections plus its `toolsAdded`
 * schemas, thinking and tool-call arguments as text, and an image as 4800 characters.
 */

/** Tokens of the one system message pi-ai would send after replaying `messages`: current sections, content, and tools. */
function effectiveSystemTokens(messages: readonly Message[]): number {
	const current = getCurrentSystemMessage(messages);
	return current ? estimateMessageTokens(current) : 0;
}

/**
 * Tokens of the prompt that is in effect after compaction. Durable's placement omits every system entry of the kept
 * context and writes one baseline of the current sections and tools (pi-durable `planSystemEntries`), so a section or
 * tool patch before the cut stays in the prompt. The estimate replays every system message of the history and of the
 * captured request (with its request-level system prompt and tools) and takes the larger. A section that the current
 * render removed but an older entry restated can still count, which over-counts.
 */
export function overheadOf(captured: CapturedRequest | undefined, full: readonly EntryRecord[]): number {
	const history = effectiveSystemTokens(full.flatMap((entry) => (entry.model ?? []) as Message[]));
	if (!captured) return history;
	const initial = createInitialSystemMessage(captured.context.systemPrompt, captured.context.tools ? [...captured.context.tools] : undefined);
	return Math.max(history, effectiveSystemTokens([...(initial ? [initial] : []), ...captured.context.messages] as Message[]));
}

/**
 * Tokens of the entries durable keeps verbatim after the summary: the active history from the first kept entry. Its
 * system entries do not count: placement omits them, and `overheadOf` counts their effect.
 */
export function tailTokens(full: readonly EntryRecord[], firstKept: number): number {
	let tokens = 0;
	for (const entry of full) if (Number(entry.id) >= firstKept) for (const m of (entry.model ?? []) as Message[]) if ((m.role as string) !== "system") tokens += estimateMessageTokens(m);
	return tokens;
}

/** The start of every fit reason, so a surface can name the outcome without parsing the arithmetic. */
export const NO_FIT = "the summary does not fit";

/**
 * Why the installed summary and the context that stays verbatim would not fit under the compaction trigger, or
 * undefined. A summary that does not fit starts another compaction at once.
 */
export function fitGap(parts: { summaryTokens: number; tailTokens: number; overheadTokens: number; limit: number }): string | undefined {
	const total = parts.summaryTokens + parts.tailTokens + parts.overheadTokens;
	if (total <= parts.limit) return undefined;
	return `${NO_FIT}: summary ${parts.summaryTokens} + kept tail ${parts.tailTokens} + prompt ${parts.overheadTokens} = ${total} tokens, over the ${parts.limit}-token compaction trigger`;
}

/** The prefix gap when this process has captured no request for the conversation, as after a restart. */
export const NO_CAPTURE = "no request captured for this conversation in this process";

/**
 * Why the captured request cannot serve as the plan's prefix, or undefined when it covers every replaced message.
 * A replaced assistant answer newer than the capture is allowed: it has no tool output, and the Rarebit record keeps
 * its prose.
 */
export function prefixGap(captured: CapturedRequest | undefined, replaced: readonly Message[], model: { provider: string; id: string }): string | undefined {
	if (!captured) return NO_CAPTURE;
	if (captured.model.provider !== model.provider || captured.model.id !== model.id) return `the last request used ${captured.model.provider}/${captured.model.id}`;
	const key = (m: Message) => `${m.role}\u0000${(m as { timestamp?: number }).timestamp}\u0000${JSON.stringify((m as { content?: unknown }).content)}`;
	const sent = new Set(captured.context.messages.map(key));
	const missing = replaced.filter((m) => !sent.has(key(m)) && !(m.role === "assistant" && !(m.content as { type?: string }[]).some((b) => b?.type === "toolCall")));
	if (missing.length) return `the last request misses ${missing.length} replaced message${missing.length === 1 ? "" : "s"}`;
	return undefined;
}

export type PlannerUsage = { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };

/**
 * Ask the planner: the captured request plus the planning prompt as one user message. A reply that calls a tool gets
 * error results that ask for the plan, up to three requests, as Pi's fork does.
 */
export async function requestPlan(
	models: { completeSimple: (model: Model<never>, context: never, options?: StreamOptions) => Promise<AssistantMessage> },
	captured: CapturedRequest,
	prompt: string,
	signal: AbortSignal | undefined,
): Promise<{ plan: Plan; usage: PlannerUsage; requests: number }> {
	const spent = { usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, requests: 0 };
	try {
		return await ask(models, captured, prompt, signal, spent);
	} catch (error) {
		// A paid request that produced no plan still belongs in the record.
		throw Object.assign(error as Error, { spent });
	}
}

async function ask(
	models: Parameters<typeof requestPlan>[0],
	captured: CapturedRequest,
	prompt: string,
	signal: AbortSignal | undefined,
	spent: { usage: PlannerUsage; requests: number },
): Promise<{ plan: Plan; usage: PlannerUsage; requests: number }> {
	const usage = spent.usage;
	const messages: Message[] = [...captured.context.messages, { role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }];
	const maxTokens = Math.max(captured.options.maxTokens ?? 0, 4096);
	for (let request = 1; request <= 3; request++) {
		const message = await models.completeSimple(captured.model, { ...captured.context, messages } as never, {
			...captured.options,
			maxTokens,
			signal,
			[PLANNER_REQUEST]: { prefixMessages: captured.prefixMessages } satisfies PlannerMark,
		} as StreamOptions);
		spent.requests = request;
		usage.input += message.usage?.input ?? 0;
		usage.output += message.usage?.output ?? 0;
		usage.cacheRead += message.usage?.cacheRead ?? 0;
		usage.cacheWrite += message.usage?.cacheWrite ?? 0;
		usage.cost += message.usage?.cost?.total ?? 0;
		if (message.stopReason === "error" || message.stopReason === "aborted") throw new Error(message.errorMessage ?? `planner ended with ${message.stopReason}`);
		if (message.stopReason === "length") throw new PlanRejected("the plan hit the output limit");
		const plan = readPlan(message);
		if (plan) return { plan, usage, requests: request };
		const note = "Tools are not executed. Return only complete JSON with summary (nonempty string) and keep (string array).";
		const calls = message.content.filter((block) => block.type === "toolCall") as { id: string; name: string }[];
		messages.push(message, ...calls.map((call) => ({ role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text: note }], isError: true, timestamp: Date.now() }) as Message));
	}
	throw new PlanRejected("the planner returned no plan after three requests");
}
