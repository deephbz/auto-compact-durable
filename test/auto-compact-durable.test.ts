// Smoke tests: the budget rules, the HC summary sections over synthetic durable history, and the compaction hook with
// a fake host API. No pi-durable runtime, model, or network is involved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentDoc, type EntryRecord } from "@earendil-works/pi-durable";
import {
	assembleSummary,
	type CompactRecord,
	compactionSettings,
	compactTrigger,
	contextTokensOf,
	conversationRecord,
	droppedIndex,
	hcCompactExtension,
	workingBudget,
} from "../src/index.ts";

test("W is the per-model budget, else the global one, else the window, never above the window", () => {
	assert.equal(workingBudget(1_000_000, { budgetTokens: 200_000, modelBudgetTokens: 400_000 }), 400_000);
	assert.equal(workingBudget(1_000_000, { budgetTokens: 200_000 }), 200_000);
	assert.equal(workingBudget(1_000_000), 1_000_000);
	assert.equal(workingBudget(128_000, { budgetTokens: 200_000 }), 128_000);
	assert.equal(workingBudget(128_000, { budgetTokens: 0 }), 128_000);
});

test("the compaction trigger is the threshold share of W, kept inside the window-edge floor and a 1024 minimum", () => {
	assert.equal(compactTrigger(1_000_000, { budgetTokens: 200_000, thresholdPercent: 75 }), 150_000);
	assert.equal(compactTrigger(100_000, { thresholdPercent: 100 }), 100_000 - 2048);
	assert.equal(compactTrigger(64_000, { budgetTokens: 500 }), 1024);
});

test("context tokens add the last response's input, output, and cache tokens and ignore unusable counts", () => {
	assert.equal(contextTokensOf({ input: 10, output: 5, cacheRead: 100, cacheWrite: null }), 115);
	assert.equal(contextTokensOf({ input: -3, output: Number.NaN }), 0);
});

test("the verbatim keep share defaults to a quarter of W, capped at 20k, and an explicit value wins", () => {
	assert.deepEqual(compactionSettings({ budgetTokens: 8_000 }), { enabled: true, keepRecentTokens: 2_000 });
	assert.deepEqual(compactionSettings({ budgetTokens: 400_000 }), { enabled: true, keepRecentTokens: 20_000 });
	assert.deepEqual(compactionSettings({ budgetTokens: 8_000, keepRecentTokens: 500 }), { enabled: true, keepRecentTokens: 500 });
	assert.deepEqual(compactionSettings(), { enabled: true });
});

const T0 = Date.UTC(2026, 0, 1);
const user = (id: number, text: string) =>
	({ id, kind: "pi.user", model: [{ role: "user", content: [{ type: "text", text }], timestamp: T0 + id }] }) as unknown as EntryRecord;
const assistant = (id: number, content: unknown[], stopReason: "stop" | "toolUse") =>
	({ id, kind: "pi.assistant", model: [{ role: "assistant", content, stopReason, timestamp: T0 + id }] }) as unknown as EntryRecord;
const toolResult = (id: number, toolCallId: string, text: string, isError = false) =>
	({ id, kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId, toolName: "read", content: [{ type: "text", text }], isError, timestamp: T0 + id }] }) as unknown as EntryRecord;

const history = [
	user(1, "Add a retry to the uploader"),
	assistant(2, [{ type: "text", text: "Reading the uploader." }, { type: "toolCall", id: "c1", name: "read", arguments: { path: "src/upload.ts" } }], "toolUse"),
	toolResult(3, "c1", "x".repeat(400)),
	assistant(4, [{ type: "text", text: "Retry added with backoff." }], "stop"),
	user(5, "Now cover it with a test"),
];

test("the conversation record keeps the newest prose that fits and renders it oldest-first", () => {
	const all = conversationRecord(history);
	assert.equal(all.count, 4);
	assert.equal(all.omitted, 0);
	assert.ok(all.text.indexOf("[USER]\nAdd a retry") < all.text.indexOf("[USER]\nNow cover it"));
	const tight = conversationRecord(history, 20);
	assert.equal(tight.count, 2);
	assert.equal(tight.omitted, 2);
	assert.match(tight.text, /^\[2 older messages omitted for budget; rarebit_recall rereads them\]/);
	assert.match(tight.text, /Now cover it with a test$/);
});

test("the dropped-tool index pairs each call with its result size and flags calls without one", () => {
	const index = droppedIndex([...history, assistant(6, [{ type: "toolCall", id: "c2", name: "bash", arguments: { cmd: "ls" } }], "toolUse")]);
	assert.equal(index.count, 2);
	assert.match(index.text, /- read \{"path":"src\/upload.ts"\} · 100 tok/);
	assert.match(index.text, /- bash \{"cmd":"ls"\} · no result/);
});

test("the assembled summary carries the three sections in order", () => {
	const summary = assembleSummary({ working: "Goal: retry", record: "[USER]\nhi", dropped: "" });
	const at = ["## Working-state summary", "## Conversation record", "## Dropped tool results"].map((h) => summary.indexOf(h));
	assert.deepEqual(at, [...at].sort((a, b) => a - b));
	assert.ok(at.every((i) => i >= 0));
	assert.match(summary, /\(none\)$/);
});

// A fake host: one model, in-memory memo, and a completion the test controls.
function fakeApi(reply?: () => unknown) {
	const memo = new Map<string, unknown>();
	return {
		conversationId: "c",
		snapshot: async (doc: unknown) => (doc === AgentDoc ? { model: { provider: "p", modelId: "m" } } : { sessionId: "s" }),
		models: {
			getModel: () => ({ maxTokens: 4000, contextWindow: 128_000 }),
			completeSimple: async () => reply?.() ?? { stopReason: "stop", content: [{ type: "text", text: "Goal: retry\nNext: test" }] },
		},
		// memo(name, context) reads; memo(name, candidate, context) stores.
		memo: async (name: string, a: unknown, b?: unknown) => (b === undefined ? memo.get(name) : (memo.set(name, a), a)),
	} as any;
}

const compaction = { reason: "threshold", entries: history.slice(0, 4), messages: history.slice(0, 4).flatMap((e) => (e as any).model), firstKept: 5 } as any;
const beforeCompact = (options: Parameters<typeof hcCompactExtension>[0]) => (hcCompactExtension(options).hooks as any)[0].handlers.beforeCompact;

test("the hook writes the HC summary with the full-history record and reports the method", async () => {
	const records: CompactRecord[] = [];
	const api = fakeApi();
	const result = await beforeCompact({ method: () => "summary", history: async () => history, record: (_api, r) => void records.push(r) })(compaction, api, {});
	assert.match(result.summary, /Goal: retry/);
	// The record covers the replaced range of the full history: entry 5 is the first one kept verbatim.
	assert.match(result.summary, /\[USER\]\nAdd a retry to the uploader/);
	assert.doesNotMatch(result.summary, /Now cover it with a test/);
	assert.equal(records[0]?.method, "hc-summary");
	assert.equal(records[0]?.conversationRecord?.fullHistory, true);
	assert.equal(records[0]?.droppedTools, 1);
});

test("a failed model call falls back to native compaction and says why", async () => {
	const records: CompactRecord[] = [];
	const api = fakeApi(() => ({ stopReason: "error", errorMessage: "provider down", content: [] }));
	const result = await beforeCompact({ method: () => "summary", record: (_api, r) => void records.push(r) })(compaction, api, {});
	assert.equal(result, undefined);
	assert.equal(records[0]?.method, "native-fallback");
	assert.equal(records[0]?.error, "provider down");
});
