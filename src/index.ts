// HyperCarrier Auto Compact, adapted to pi-durable. Pi-durable already owns what the Pi-era extension had to build:
// compaction tasks that summarize while the conversation keeps working, placement at turn boundaries, overflow
// recovery, and crash recovery. What HyperCarrier adds is policy and content:
// - a working budget W per model, resolved as Pi's Auto Compact resolves it (K2.I1). The host requests a compaction
//   when a response's context reaches the threshold share of W; durable's own window-edge threshold stays as the
//   hard floor;
// - the HC summary method: the model's working-state summary first (primary, D5), then framework-selected safety
//   floors: a Rarebit conversation record over the *full* durable history (newest first, 12k-token cap, rendered
//   oldest-first) and an index of dropped tool results;
// - a record of which method produced each compaction and why a fallback happened (C3: failures are visible).
// The Pi-era pre-compaction handoff turn is not ported: the durable transcript and `rarebit_recall` keep every
// exact earlier word recoverable after compaction, which is what the handoff turn protected.

import type { Context } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import { estimateTextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { AgentDoc, CompactionTask, defineExtension, type EntryRecord, type HookApi, hook, ProviderDoc } from "@earendil-works/pi-durable";
import { select } from "@hypercarrier/rarebit-durable";
import type { BudgetOptions } from "./budget.ts";
import { type CapturedRequest, collectRounds, fitGap, keepCap, keptBlock, overheadOf, PLAN_KEYS, type Plan, PlanRejected, type PlannerUsage, planPrompt, prefixGap, renderKept, requestPlan, resolveKeep, tailTokens } from "./keepset.ts";

export { type BudgetOptions, compactTrigger, contextTokensOf, workingBudget } from "./budget.ts";
export { type CapturedRequest, keepCap, PLAN_PROMPT_PREFIX, PLANNER_REQUEST, type PlannerMark } from "./keepset.ts";

export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

/** Harness-wide durable compaction settings for the HC policy. */
export function compactionSettings(options: BudgetOptions = {}) {
	// Keep-recent is harness-wide here; an absolute W cap bounds it so a compaction always has a range.
	const keep = options.keepRecentTokens ?? (options.budgetTokens ? Math.min(20_000, Math.floor(options.budgetTokens / 4)) : undefined);
	return { enabled: true, ...(keep !== undefined ? { keepRecentTokens: keep } : {}) };
}

export type CompactMethod = "keepset" | "summary" | "native";

export type CompactRecord = {
	/** `native`: the owner chose durable's own summary. `native-fallback`: the chosen method failed; `error` says why. */
	method: "keepset" | "hc-summary" | "native" | "native-fallback";
	/** The compaction task; its placed summary entry carries the same `byTaskId`. */
	taskId?: string;
	/** Hook runs for this task, counting the one that recorded; above 1 after a restart. */
	attempts?: number;
	/** Durable's reason, or `working_budget` when the host asked because a response reached the threshold share of W. */
	reason: string;
	trigger?: { tokens: number; workingBudget: number };
	at: number;
	replacedEntries: number;
	firstKept: number;
	conversationRecord?: { count: number; omitted: number; tokens: number; fullHistory: boolean };
	droppedTools?: number;
	summaryTokens?: number;
	model?: string;
	error?: string;
	/** Keepset: the outputs kept verbatim (in history order) and the dropped ones, linked by entry. */
	keep?: {
		cap: number;
		perItemTokens: number;
		keptTokens: number;
		kept: { label: string; name: string; entryId?: string; tokens: number; cut?: boolean }[];
		dropped: { label: string; name: string; entryId?: string; tokens: number; args: string }[];
		droppedCount: number;
	};
	/** The paid planning request, also when its plan was rejected. `cache` is the cache fact the owner reads. */
	planner?: { model: string; requests: number; usage: PlannerUsage; promptTokens: number; cache: string };
	/** Set when a returned plan was not installed. */
	planRejected?: string;
};

export const WORKING_PROMPT_PREFIX = "You are compacting a coding-agent conversation.";

const WORKING_PROMPT = `${WORKING_PROMPT_PREFIX} Below is the part of the conversation that is about to leave your context. Write the working-state summary you will need to continue the work without it.

Write concise Markdown with these sections: Goal; Constraints & preferences; Done; In progress; Decisions (with one-line rationale); Open questions for the user; Next steps; Files and commands that matter (exact paths and identifiers).
The user's exact messages and your earlier prose answers will be appended separately, so do not quote them at length. Tool results will be dropped; record only the facts from them that later work depends on. Do not continue the conversation. Output only the summary.`;

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block: { type?: string; text?: string; thinking?: string; name?: string; arguments?: unknown }) => {
			if (block?.type === "text") return block.text ?? "";
			if (block?.type === "image") return "[image]";
			if (block?.type === "toolCall") return `→ ${block.name}(${oneLine(JSON.stringify(block.arguments ?? {}), 300)})`;
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

function oneLine(value: string, max: number): string {
	const s = value.replace(/\s+/g, " ").trim();
	return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** The replaced range as plain text (tool calls inline, results clipped): providers reject raw tool blocks without tools. */
export function serializeRange(messages: readonly Message[], maxChars = 240_000): string {
	const parts: string[] = [];
	for (const message of messages) {
		// biome-ignore lint: loosely typed pi-ai message
		const m = message as any;
		if (m.role === "user") parts.push(`[User]\n${textOf(m.content)}`);
		else if (m.role === "assistant") parts.push(`[Assistant]\n${textOf(m.content)}`);
		else if (m.role === "toolResult") {
			const text = textOf(m.content);
			parts.push(`[Tool result: ${m.toolName}${m.isError ? " (error)" : ""}]\n${text.length > 2000 ? `${text.slice(0, 2000)}\n[… ${text.length - 2000} chars omitted]` : text}`);
		}
	}
	let joined = parts.join("\n\n");
	if (joined.length > maxChars) joined = `[… earlier part omitted]\n${joined.slice(joined.length - maxChars)}`;
	return joined;
}

/** Newest Rarebit prose within the budget, rendered oldest-first (the HC conversation record). */
export function conversationRecord(entries: readonly EntryRecord[], budgetTokens = 12_000) {
	const { occurrences } = select(entries);
	const picked: string[] = [];
	let used = 0;
	let omitted = 0;
	for (let i = occurrences.length - 1; i >= 0; i--) {
		const o = occurrences[i]!;
		const text = o.text.trim();
		if (!text) continue;
		const block = `[${o.role === "user" ? "USER" : "AGENT"}]\n${text}`;
		const cost = estimateTokens(block);
		if (used + cost > budgetTokens) {
			omitted++;
			continue;
		}
		used += cost;
		picked.push(block);
	}
	picked.reverse();
	const head = omitted ? [`[${omitted} older messages omitted for budget; rarebit_recall rereads them]`] : [];
	return { text: [...head, ...picked].join("\n\n"), tokens: used, count: picked.length, omitted };
}

/** One line per tool call whose result leaves context. */
export function droppedIndex(entries: readonly EntryRecord[], max = 80): { text: string; count: number } {
	const lines: string[] = [];
	const results = new Map<string, { tokens: number; isError: boolean }>();
	for (const entry of entries) {
		if (entry.kind !== "pi.tool-result") continue;
		// biome-ignore lint: loosely typed pi-ai message
		const m = entry.model?.[0] as any;
		results.set(String(m?.toolCallId), { tokens: estimateTokens(textOf(m?.content)), isError: m?.isError === true });
	}
	for (const entry of entries) {
		if (entry.kind !== "pi.assistant") continue;
		// biome-ignore lint: loosely typed pi-ai message
		for (const block of ((entry.model?.[0] as any)?.content ?? []) as any[]) {
			if (block?.type !== "toolCall") continue;
			const result = results.get(String(block.id));
			lines.push(`- ${block.name} ${oneLine(JSON.stringify(block.arguments ?? {}), 120)}${result ? ` · ${result.tokens} tok${result.isError ? " · error" : ""}` : " · no result"}`);
		}
	}
	const shown = lines.slice(-max);
	return { text: [...(lines.length > max ? [`- … ${lines.length - max} earlier calls`] : []), ...shown].join("\n"), count: lines.length };
}

/** The first kept entry as the planner sees it, so the plan knows where the verbatim tail starts. */
function describe(entry: EntryRecord | undefined): string | undefined {
	// biome-ignore lint: loosely typed pi-ai message
	const m = entry?.model?.[0] as any;
	if (!m) return undefined;
	const text = oneLine(textOf(m.content), 160);
	return `${m.role === "toolResult" ? `the ${m.toolName} result` : m.role === "user" ? "the user's message" : "your message"}${text ? ` "${text}"` : ""}`;
}

export function assembleSummary(parts: { working: string; record: string; dropped: string; kept?: string }): string {
	return [
		"## Working-state summary (written by you just before compaction)",
		parts.working.trim() || "(no summary provided)",
		...(parts.kept !== undefined
			? ["## Tool results you chose to keep (verbatim, captured before compaction — files may have changed since)", parts.kept || "(none kept)"]
			: []),
		"## Conversation record (user messages and assistant prose, from the full durable history)",
		parts.record || "(none)",
		"## Dropped tool results (output not in context; repeat a read-only call if needed, never a mutating one)",
		parts.dropped || "(none)",
	].join("\n\n");
}

export type CompactOptions = {
	/** Full durable history of the conversation (ascending). Without it the record covers only the replaced range. */
	history?: (api: HookApi, context: Context) => Promise<readonly EntryRecord[]>;
	/** Record the method and outcome of each compaction (C3). */
	record?: (api: HookApi, record: CompactRecord) => void | Promise<void>;
	recordBudgetTokens?: number;
	/** The conversation's method; keepset when absent. */
	method?: (api: HookApi, context: Context) => CompactMethod | Promise<CompactMethod>;
	/** The last real request of the provider session, for the keepset planner's cached prefix. */
	lastRequest?: (sessionId: string | undefined) => CapturedRequest | undefined;
	/** The working budget W, for the keep cap min(20000, W/4). */
	workingBudget?: (api: HookApi, context: Context) => number | undefined | Promise<number | undefined>;
	/** The context size that starts a compaction; an installed summary must fit under it. W when absent. */
	trigger?: (api: HookApi, context: Context) => number | undefined | Promise<number | undefined>;
	/** Called after the plan memo is written (crash tests). */
	afterPlan?: (api: HookApi, context: Context) => void | Promise<void>;
};

/** The paid plan, with the planner model and the prompt overhead it was measured against. */
type PlanMemo = Plan & { usage: PlannerUsage; requests: number; model: string; overheadTokens: number };

/** The history cannot be read, so the kept tail cannot be measured: the fit check fails safe. */
const NO_HISTORY = "the fit check cannot read the history";

const promptTokens = (u: PlannerUsage) => u.input + u.cacheRead + u.cacheWrite;
function cacheFact(u: PlannerUsage): string {
	const prompt = promptTokens(u);
	if (!prompt) return "no usage reported";
	return u.cacheRead ? `${Math.round((100 * u.cacheRead) / prompt)}% of ${prompt} prompt tokens read from cache` : "no cache reuse: the provider reported no cache read";
}
const plannerRecord = (memo: Pick<PlanMemo, "usage" | "requests" | "model">) => ({ model: memo.model, requests: memo.requests, usage: memo.usage, promptTokens: promptTokens(memo.usage), cache: cacheFact(memo.usage) });

export function hcCompactExtension(options: CompactOptions = {}) {
	return defineExtension({
		name: "hc-compact",
		hooks: [
			hook(CompactionTask, {
				async beforeCompact(compaction, api, context) {
					// Each hook run takes the next attempt number; a run after a restart sees the earlier ones.
					let attempts = 1;
					while ((await api.memo<boolean>(`hc-compact.attempt.${attempts}`, context)) !== undefined) attempts++;
					await api.memo(`hc-compact.attempt.${attempts}`, true, context);
					const base = {
						taskId: String(api.taskId),
						attempts,
						reason: compaction.reason,
						at: Date.now(),
						replacedEntries: compaction.entries.length,
						firstKept: Number(compaction.firstKept),
					};
					// The first run pins the method: a later method change cannot bypass a plan this task already paid for.
					const method = await api.memo<CompactMethod>("hc-compact.method", (await options.method?.(api, context)) ?? "keepset", context);
					if (method === "native") {
						await options.record?.(api, { method: "native", ...base });
						return undefined;
					}
					let modelName: string | undefined;
					let planner: CompactRecord["planner"];
					try {
						const agent = await api.snapshot(AgentDoc, api.conversationId, context);
						const ref = agent?.model;
						const model = ref ? api.models.getModel(ref.provider, ref.modelId) : undefined;
						if (!ref || !model) throw new Error("no model configured for the working-state summary");
						modelName = `${ref.provider}/${ref.modelId}`;
						// The provider session names the conversation, as in durable's native summary request, so a host can
						// admit or hold the request by conversation.
						const sessionId = (await api.snapshot(ProviderDoc, api.conversationId, context))?.sessionId;
						const full = options.history ? await options.history(api, context).catch(() => undefined) : undefined;
						const recordSource = full ? full.filter((entry) => Number(entry.id) < Number(compaction.firstKept)) : compaction.entries;
						const record = conversationRecord(recordSource, options.recordBudgetTokens ?? 12_000);
						const fullHistory = full !== undefined;
						// The fit limit is this task's, like the cap. The fit check estimates at hook time; placement owns the installed context.
						const limit = await api.memo<number>("hc-compact.limit", (await options.trigger?.(api, context)) ?? (await options.workingBudget?.(api, context)) ?? model.contextWindow, context);
						// The tail is measured on a fresh history: the conversation can grow while the summary is written.
						const fits = async (summary: string, overheadTokens: (now: readonly EntryRecord[]) => number) => {
							let now: readonly EntryRecord[];
							try {
								if (!options.history) throw new Error("no history source");
								now = await options.history(api, context);
							} catch (error) {
								return `${NO_HISTORY}: ${(error as Error).message}`;
							}
							return fitGap({ summaryTokens: estimateTextTokens(summary), tailTokens: tailTokens(now, Number(compaction.firstKept)), overheadTokens: overheadTokens(now), limit });
						};
						if (method === "keepset") {
							const rounds = collectRounds(compaction.entries);
							// The cap and the plan are this task's: a restart installs the same selection without a second paid call.
							const cap = await api.memo("hc-compact.cap", keepCap(await options.workingBudget?.(api, context)), context);
							let memo = await api.memo<PlanMemo>("hc-compact.plan", context);
							if (memo === undefined) {
								const captured = options.lastRequest?.(sessionId);
								const gap = prefixGap(captured, compaction.messages, { provider: ref.provider, id: ref.modelId });
								if (gap || !captured) throw new Error(`no cache reuse: ${gap}`);
								const prompt = planPrompt(rounds, { budgetTokens: cap, keptFrom: describe(full?.find((entry) => String(entry.id) === String(compaction.firstKept))), ...(compaction.instructions ? { instructions: compaction.instructions } : {}) });
								try {
									const result = await requestPlan(api.models as never, captured, prompt, context.abortSignal);
									memo = { ...result.plan, usage: result.usage, requests: result.requests, model: modelName, overheadTokens: overheadOf(captured, []) };
								} catch (error) {
									const spent = (error as { spent?: { usage: PlannerUsage; requests: number } }).spent;
									if (spent?.requests) planner = plannerRecord({ ...spent, model: modelName });
									throw error;
								}
								memo = await api.memo<PlanMemo>("hc-compact.plan", memo as PlanMemo, context);
								await options.afterPlan?.(api, context);
							}
							planner = plannerRecord(memo);
							const resolved = resolveKeep(rounds, memo.keep, cap);
							const shown = resolved.dropped.slice(-80);
							const droppedText = [
								...(resolved.dropped.length > shown.length ? [`- … ${resolved.dropped.length - shown.length} earlier calls`] : []),
								...shown.map((round) => `- ${round.label} · ${round.name} ${oneLine(JSON.stringify(round.args), 120)} · ${round.tokens} tok${round.isError ? " · error" : ""}`),
							].join("\n");
							const summary = assembleSummary({ working: memo.summary, kept: renderKept(resolved.kept), record: record.text, dropped: droppedText });
							// A plan saved before a restart keeps its overhead; the current history and request can only add to it.
							const gap = await fits(summary, (now) => Math.max(memo.overheadTokens ?? 0, overheadOf(options.lastRequest?.(sessionId), now)));
							if (gap) throw new PlanRejected(gap);
							await options.record?.(api, {
								method: "keepset",
								...base,
								conversationRecord: { count: record.count, omitted: record.omitted, tokens: record.tokens, fullHistory },
								droppedTools: resolved.dropped.length,
								summaryTokens: estimateTokens(summary),
								model: memo.model,
								planner,
								keep: {
									cap,
									perItemTokens: PLAN_KEYS.perItemTokens,
									keptTokens: resolved.tokens,
									kept: resolved.kept.map((round) => ({ label: round.label, name: round.name, entryId: round.resultEntryId, tokens: round.keptTokens, ...(keptBlock(round).cut ? { cut: true } : {}) })),
									dropped: resolved.dropped.slice(-200).map((round) => ({ label: round.label, name: round.name, entryId: round.resultEntryId ?? round.callEntryId, tokens: round.tokens, args: oneLine(JSON.stringify(round.args), 120) })),
									droppedCount: resolved.dropped.length,
								},
							});
							return { summary };
						}
						// A crash after the model answered reuses the answer instead of paying for it again.
						let working = await api.memo<string>("hc-compact.working", context);
						if (working === undefined) {
							const prompt = `${WORKING_PROMPT}${compaction.instructions ? `\n\nThe user asked this compaction to focus on: ${compaction.instructions}` : ""}\n\n<conversation>\n${serializeRange(compaction.messages)}\n</conversation>`;
							const message = await api.models.completeSimple(
								model,
								{ messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }] },
								{ maxTokens: Math.min(model.maxTokens > 0 ? model.maxTokens : 8000, 8000), signal: context.abortSignal, ...(sessionId ? { sessionId } : {}) },
							);
							if (message.stopReason === "error" || message.stopReason === "aborted" || message.stopReason === "length")
								throw new Error(message.errorMessage ?? `working-state summary ended with ${message.stopReason}`);
							working = textOf(message.content).trim();
							if (!working) throw new Error("working-state summary was empty");
							working = await api.memo("hc-compact.working", working, context);
						}
						const dropped = droppedIndex(compaction.entries);
						const summary = assembleSummary({ working, record: record.text, dropped: dropped.text });
						const captured = options.lastRequest?.(sessionId);
						const gap = await fits(summary, (now) => overheadOf(captured, now));
						if (gap) throw new Error(gap);
						await options.record?.(api, {
							method: "hc-summary",
							...base,
							conversationRecord: { count: record.count, omitted: record.omitted, tokens: record.tokens, fullHistory },
							droppedTools: dropped.count,
							summaryTokens: estimateTokens(summary),
							model: modelName,
						});
						return { summary };
					} catch (error) {
						if (context.abortSignal?.aborted) throw error;
						// Fall back to durable's native summary; the record says so and why, and what the planner cost.
						const rejected = error instanceof PlanRejected ? { planRejected: error.message } : {};
						await Promise.resolve(options.record?.(api, { method: "native-fallback", ...base, error: (error as Error).message, ...rejected, ...(planner ? { planner } : {}), ...(modelName ? { model: modelName } : {}) })).catch(() => {});
						return undefined;
					}
				},
			}),
		],
	});
}
