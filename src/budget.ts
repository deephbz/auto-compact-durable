// The working budget W and the compaction trigger, shared by the AmPi node (durable) and the Pi Host view (K2.I1).
// No imports: the hub reads it without loading pi-durable.

export type BudgetOptions = {
	/** The compaction trigger as a share of W, in percent (HC default 90; Pi `auto_compact.threshold`). */
	thresholdPercent?: number;
	/** W in tokens (Pi `auto_compact.budget_tokens`). Without it W is the context window. */
	budgetTokens?: number;
	/** This model's W, which wins over `budgetTokens` (Pi `auto_compact.modelOverrides[model].budget_tokens`). */
	modelBudgetTokens?: number;
	/** Recent context kept verbatim by every compaction (durable default 20k tokens). */
	keepRecentTokens?: number;
};

const positive = (n: number | undefined) => (n !== undefined && n > 0 ? n : undefined);

/**
 * The working budget W for one model (K2.I1): the owner's per-model budget, else the global one, else the context
 * window, never above the window. Pi's Auto Compact resolves the same W, so the context figure `contextTokens / W`
 * is one number on both carriers for the same settings.
 */
export function workingBudget(contextWindow: number, options: BudgetOptions = {}): number {
	return Math.min(positive(options.modelBudgetTokens) ?? positive(options.budgetTokens) ?? contextWindow, contextWindow);
}

/** The context size at which the host asks for a compaction: the threshold share of W, below durable's window-edge floor. */
export function compactTrigger(contextWindow: number, options: BudgetOptions = {}): number {
	const percent = options.thresholdPercent ?? 90;
	const trigger = Math.ceil((workingBudget(contextWindow, options) * percent) / 100);
	return Math.max(1024, Math.min(trigger, contextWindow - 2048));
}

type Usage = { input?: number | null; output?: number | null; cacheRead?: number | null; cacheWrite?: number | null };
const tokens = (n: number | null | undefined) => (typeof n === "number" && n > 0 ? n : 0);

/** The context figure's numerator on both carriers: the last response's input, output and cache tokens. */
export function contextTokensOf(usage: Usage): number {
	return tokens(usage.input) + tokens(usage.output) + tokens(usage.cacheRead) + tokens(usage.cacheWrite);
}
