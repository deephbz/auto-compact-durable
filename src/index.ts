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
import { AgentDoc, CompactionTask, defineExtension, type EntryRecord, type HookApi, hook, ProviderDoc } from "@earendil-works/pi-durable";
import { select } from "@hypercarrier/rarebit-durable";
import type { BudgetOptions } from "./budget.ts";

export { type BudgetOptions, compactTrigger, contextTokensOf, workingBudget } from "./budget.ts";

export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

/** Harness-wide durable compaction settings for the HC policy. */
export function compactionSettings(options: BudgetOptions = {}) {
	// Keep-recent is harness-wide here; an absolute W cap bounds it so a compaction always has a range.
	const keep = options.keepRecentTokens ?? (options.budgetTokens ? Math.min(20_000, Math.floor(options.budgetTokens / 4)) : undefined);
	return { enabled: true, ...(keep !== undefined ? { keepRecentTokens: keep } : {}) };
}

export type CompactRecord = {
	method: "hc-summary" | "native-fallback";
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

export function assembleSummary(parts: { working: string; record: string; dropped: string }): string {
	return [
		"## Working-state summary (written by you just before compaction)",
		parts.working.trim() || "(no summary provided)",
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
};

export function hcCompactExtension(options: CompactOptions = {}) {
	return defineExtension({
		name: "hc-compact",
		hooks: [
			hook(CompactionTask, {
				async beforeCompact(compaction, api, context) {
					const base = {
						reason: compaction.reason,
						at: Date.now(),
						replacedEntries: compaction.entries.length,
						firstKept: Number(compaction.firstKept),
					};
					let modelName: string | undefined;
					try {
						const agent = await api.snapshot(AgentDoc, api.conversationId, context);
						const ref = agent?.model;
						const model = ref ? api.models.getModel(ref.provider, ref.modelId) : undefined;
						if (!ref || !model) throw new Error("no model configured for the working-state summary");
						modelName = `${ref.provider}/${ref.modelId}`;
						// A crash after the model answered reuses the answer instead of paying for it again.
						let working = await api.memo<string>("hc-compact.working", context);
						if (working === undefined) {
							// The provider session names the conversation, as in durable's native summary request, so a host can
							// admit or hold the request by conversation.
							const sessionId = (await api.snapshot(ProviderDoc, api.conversationId, context))?.sessionId;
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
						const full = options.history ? await options.history(api, context).catch(() => undefined) : undefined;
						const recordSource = full ? full.filter((entry) => Number(entry.id) < Number(compaction.firstKept)) : compaction.entries;
						const record = conversationRecord(recordSource, options.recordBudgetTokens ?? 12_000);
						const dropped = droppedIndex(compaction.entries);
						const summary = assembleSummary({ working, record: record.text, dropped: dropped.text });
						await options.record?.(api, {
							method: "hc-summary",
							...base,
							conversationRecord: { count: record.count, omitted: record.omitted, tokens: record.tokens, fullHistory: full !== undefined },
							droppedTools: dropped.count,
							summaryTokens: estimateTokens(summary),
							model: modelName,
						});
						return { summary };
					} catch (error) {
						if (context.abortSignal?.aborted) throw error;
						// Fall back to durable's native summary; the record says so and why.
						await Promise.resolve(options.record?.(api, { method: "native-fallback", ...base, error: (error as Error).message, ...(modelName ? { model: modelName } : {}) })).catch(() => {});
						return undefined;
					}
				},
			}),
		],
	});
}
