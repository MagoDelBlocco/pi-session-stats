/**
 * Pure logic for the pi-session-stats context bar.
 *
 * This module is the single source of truth for the token-estimation and
 * bar-building math. Both the extension (index.ts) and the test suite
 * (test.mjs) import from here, so the tests exercise the exact shipped code
 * rather than a duplicated copy — keeping the two in parity.
 *
 * 50 segments (⏥), each representing 2% of the context window. Each segment
 * is colored by the message type occupying the largest share of the token
 * span it covers:
 *   blue     = system prompt
 *   green    = user / assistant messages
 *   yellow   = read tool output
 *   red      = other tool output
 *   dim      = unused context
 */

export const SEGMENTS = 50;
export const SYMBOL = "⏥";
export const ESTIMATED_IMAGE_CHARS = 4800;

// ── Token estimation ───────────────────────────────────────────────

export function estimateMessageTokens(message: Record<string, unknown>): number {
	const role = message.role as string;

	if (role === "bashExecution") {
		const command = typeof message.command === "string" ? message.command : "";
		const output = typeof message.output === "string" ? message.output : "";
		return Math.ceil((command.length + output.length) / 4);
	}

	if (role === "branchSummary" || role === "compactionSummary") {
		const summary = typeof message.summary === "string" ? message.summary : "";
		return Math.ceil(summary.length / 4);
	}

	const content = message.content;

	if (typeof content === "string") {
		return Math.ceil(content.length / 4);
	}

	if (!Array.isArray(content)) {
		return 0;
	}

	let chars = 0;

	for (const part of content) {
		if (part.type === "text") {
			chars += typeof part.text === "string" ? part.text.length : 0;
		} else if (part.type === "thinking") {
			chars += typeof part.thinking === "string" ? part.thinking.length : 0;
		} else if (part.type === "toolCall") {
			chars += (typeof part.name === "string" ? part.name.length : 0)
				+ JSON.stringify((part as Record<string, unknown>).arguments ?? {}).length;
		} else if (part.type === "image") {
			chars += ESTIMATED_IMAGE_CHARS;
		} else if (part.type === "tool_use") {
			chars += JSON.stringify(part).length;
		}
	}

	return Math.ceil(chars / 4);
}

// ── Message range extraction ───────────────────────────────────────

export interface MessageRange {
	start: number;
	end: number;
	type: "system" | "user" | "assistant" | "tool";
	toolName?: string;
}

export function buildMessageRanges(
	entries: Array<{ type: string; message?: Record<string, unknown> }>,
): { ranges: MessageRange[] } {
	const ranges: MessageRange[] = [];
	let cursor = 0;

	for (const entry of entries) {
		if (entry.type !== "message") continue;

		const msg = entry.message as Record<string, unknown>;
		const tokens = estimateMessageTokens(msg);
		if (tokens === 0) continue;

		const role = msg.role as string;
		let type: MessageRange["type"] = "assistant";
		let toolName: string | undefined;

		if (role === "system") {
			type = "system";
		} else if (role === "user") {
			type = "user";
		} else if (role === "assistant") {
			type = "assistant";
		} else if (role === "tool" || role === "toolResult") {
			type = "tool";
			toolName = typeof msg.toolName === "string" ? msg.toolName : undefined;
		}

		ranges.push({ start: cursor, end: cursor + tokens, type, toolName });
		cursor += tokens;
	}

	return { ranges };
}

// ── Bar construction ───────────────────────────────────────────────

export function buildBar(
	ranges: MessageRange[],
	contextWindow: number,
	theme: { fg: (c: string, s: string) => string },
	used: number,
): string {
	const segmentsFilled = Math.min(
		SEGMENTS,
		Math.ceil((used / contextWindow) * SEGMENTS),
	);

	const emptySymbol = theme.fg("dim", SYMBOL);
	const tokensPerSegment = contextWindow / SEGMENTS;

	let bar = "";

	for (let i = 0; i < SEGMENTS; i++) {
		if (i >= segmentsFilled) {
			bar += emptySymbol;
			continue;
		}

		// Reverse the order of the lit segments while keeping the dim/inactive
		// segments on the right: the leftmost lit segment maps to the last
		// token span and the segment at the lit/dim boundary maps to the first.
		const src = segmentsFilled - 1 - i;

		// Span of context (in tokens) this segment represents, clamped to
		// what's actually used so the final partial segment is never a hole.
		const lo = src * tokensPerSegment;
		const hi = Math.min((src + 1) * tokensPerSegment, used);

		// Color by the message type occupying the largest share of the span.
		const range = dominantRange(ranges, lo, hi);
		bar += range ? segmentColor(range, theme) : emptySymbol;
	}

	return bar;
}

export function dominantRange(
	ranges: MessageRange[],
	lo: number,
	hi: number,
): MessageRange | undefined {
	let best: MessageRange | undefined;
	let bestOverlap = 0;

	for (const range of ranges) {
		const overlap = Math.min(range.end, hi) - Math.max(range.start, lo);
		if (overlap > bestOverlap) {
			bestOverlap = overlap;
			best = range;
		}
	}

	return best;
}

export function segmentColor(
	range: MessageRange,
	theme: { fg: (c: string, s: string) => string },
): string {
	switch (range.type) {
		case "system":
			return theme.fg("accent", SYMBOL);
		case "user":
			return theme.fg("success", SYMBOL);
		case "assistant":
			return theme.fg("success", SYMBOL);
		case "tool":
			if (range.toolName === "read") {
				return theme.fg("warning", SYMBOL);
			}
			return theme.fg("error", SYMBOL);
	}
}

// ── Formatting ─────────────────────────────────────────────────────

export function fmt(n: number): string {
	if (n < 1000) return `${n}`;
	if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
	return `${(n / 1_000_000).toFixed(1)}m`;
}

/**
 * Formats a token rate truncated to exactly 2 decimal places (e.g. `25.25`, `49.62`).
 * Truncation drops the remaining digits rather than rounding, and always shows
 * two digits after the decimal point (e.g. `5` → `5.00`).
 */
export function fmtTps(n: number): string {
	const s = String(n);
	const dot = s.indexOf(".");
	if (dot === -1) return `${s}.00`;
	const frac = (s.slice(dot + 1) + "00").slice(0, 2);
	return `${s.slice(0, dot)}.${frac}`;
}

// ── Token speed tracking ───────────────────────────────────────────

/**
 * Measures TTFT and decode tokens-per-second over the streaming lifecycle.
 * Pure wall-clock timing (injectable clock for determinism) combined with
 * provider-reported token usage:
 *
 *   - TTFT   = time from the user message to the first content block (ms)
 *   - decode = usage.output accumulated during streaming via a sliding window,
 *              reconciled to the authoritative usage at message end
 *
 * Decode counts all generated output tokens (visible text and any
 * thinking/reasoning traces), since providers report them together in
 * `usage.output`.
 *
 * The clock is injectable (defaults to Date.now) so tests are deterministic.
 */
export class TokenSpeedTracker {
	private readonly windowMs: number;
	private readonly now: () => number;

	private t0 = 0;            // TTFT start (user message)
	private t1 = 0;            // TTFT stop (first content block)
	private tEnd = 0;          // decode end (assistant message end)
	private outputTokens = 0;  // reconciled decode usage.output
	private lastOutput = 0;    // last seen usage.output during streaming
	private streamStarted = false;
	private window: Array<{ time: number; tokens: number }> = [];

	constructor(windowMs = 1000, now: () => number = Date.now) {
		this.windowMs = windowMs;
		this.now = now;
	}

	/** A user message began — start the TTFT window and reset per-turn state. */
	startUser(): void {
		this.t0 = this.now();
		this.t1 = 0;
		this.outputTokens = 0;
		this.lastOutput = 0;
		this.streamStarted = false;
		this.window = [];
	}

	/** An assistant message began — begin a fresh decode phase. */
	assistantStart(): void {
		this.tEnd = 0;
		this.outputTokens = 0;
		this.lastOutput = 0;
		this.streamStarted = false;
		this.window = [];
	}

	/**
	 * A content block arrived. Stops TTFT and begins decode streaming on the
	 * first content block. Subsequent content blocks of the same assistant
	 * message (e.g. `text_start` after `thinking_start`) must NOT reset the
	 * sliding window, so thinking tokens stay counted in the decode rate.
	 */
	firstContent(output?: number): void {
		if (this.t1 === 0) this.t1 = this.now();
		if (!this.streamStarted) {
			this.streamStarted = true;
			this.window = [];
			this.lastOutput = output ?? 0;
		}
	}

	/** A streaming delta carrying the provider-reported cumulative output count. */
	delta(usageOutput?: number): void {
		if (!this.streamStarted) return;
		const now = this.now();
		const tokens =
			usageOutput !== undefined && usageOutput > this.lastOutput
				? usageOutput - this.lastOutput
				: 0;
		if (tokens > 0) {
			this.window.push({ time: now, tokens });
			this.lastOutput = usageOutput!;
		}
		this.prune(now);
	}

	/** The assistant message ended — reconcile decode output to authoritative usage. */
	assistantEnd(output?: number): void {
		if (output && output > 0) this.outputTokens = output;
		this.tEnd = this.now();
		this.streamStarted = false;
	}

	private prune(now: number): void {
		while (this.window.length > 0 && now - this.window[0]!.time > this.windowMs) {
			this.window.shift();
		}
	}

	/** Time to first token, in milliseconds. */
	get ttftMs(): number {
		return this.t1 > 0 ? this.t1 - this.t0 : 0;
	}

	/** Live decode throughput from the sliding window (while streaming). */
	get decodeTps(): number {
		if (!this.streamStarted || this.window.length === 0) return 0;
		const now = this.now();
		const inWindow = this.window.filter((w) => now - w.time <= this.windowMs);
		const tokens = inWindow.reduce((sum, w) => sum + w.tokens, 0);
		const first = inWindow[0];
		const seconds = first ? (now - first.time) / 1000 : 0;
		return seconds > 0 ? tokens / seconds : 0;
	}

	/** Final decode throughput: reconciled output over decode elapsed time. */
	get decodeTpsAvg(): number {
		const seconds = (this.tEnd - this.t1) / 1000;
		return seconds > 0 && this.outputTokens > 0 ? this.outputTokens / seconds : 0;
	}

	/** True while an assistant stream is in progress. */
	get isStreaming(): boolean {
		return this.streamStarted;
	}

	/** Whether any counter has meaningful data to render. */
	get hasData(): boolean {
		return this.ttftMs > 0 || this.decodeTps > 0 || this.decodeTpsAvg > 0;
	}
}

/**
 * Renders the TTFT / decode counters as a string to place to the right of the
 * context bar. Uses the live sliding-window decode rate while streaming, and
 * the reconciled average after the message ends.
 */
export function renderCounters(
	tracker: TokenSpeedTracker,
	theme: { fg: (c: string, s: string) => string },
): string {
	if (!tracker.hasData) return "";
	const parts: string[] = [];

	if (tracker.ttftMs > 0) {
		parts.push(theme.fg("warning", `ttft ${tracker.ttftMs}ms`));
	}
	const decode = tracker.isStreaming ? tracker.decodeTps : tracker.decodeTpsAvg;
	if (decode > 0) {
		parts.push(theme.fg("success", `decode ${fmtTps(decode)}/s`));
	}

	return parts.length > 0 ? " │ " + parts.join(" · ") : "";
}
