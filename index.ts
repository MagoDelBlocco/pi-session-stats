/**
 * Context Bar Footer — replaces the pi footer with a horizontal bar
 * visualizing context window usage by message type.
 *
 * 50 segments (⏥), each representing 2% of the context window. Each
 * segment is colored by the message type occupying the largest share of
 * the token span it covers:
 *   blue     = system prompt
 *   green    = user / assistant messages
 *   yellow   = read tool output
 *   red      = other tool output
 *   dim      = unused context
 *
 * The lit segments are laid out in reverse order (most recent on the left,
 * oldest at the lit/dim boundary); unused context stays dim on the right.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

const SEGMENTS = 50;
const SYMBOL = "⏥";
const ESTIMATED_IMAGE_CHARS = 4800;
const encoder = new TextEncoder();

// ── Token estimation ───────────────────────────────────────────────

function estimateMessageTokens(message: Record<string, unknown>): number {
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

interface MessageRange {
	start: number;
	end: number;
	type: "system" | "user" | "assistant" | "tool";
	toolName?: string;
}

function buildMessageRanges(
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

function buildBar(
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

function dominantRange(
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

function segmentColor(
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

function fmt(n: number): string {
	if (n < 1000) return `${n}`;
	if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
	return `${(n / 1_000_000).toFixed(1)}m`;
}

// ── Footer renderer factory ────────────────────────────────────────

function makeFooterRender(ctx: ExtensionContext) {
	return function (tui: unknown, _theme: unknown, footerData: { getExtensionStatuses: () => ReadonlyMap<string, string> }, width: number): string[] {
		const lines: string[] = [];
		const theme = ctx.ui.theme;

		// Line 1: cwd on blue background (shadow mode style)
		lines.push(truncateToWidth(theme.bg("customMessageBg", theme.fg("accent", ctx.cwd)), width));

		// Line 2: context bar
		const contextWindow = ctx.model?.contextWindow;

		if (contextWindow) {
			const { ranges } = buildMessageRanges(ctx.sessionManager.getBranch());
			const estimatedUsed = ranges.length > 0 ? ranges[ranges.length - 1]!.end : 0;
			const actualUsage = ctx.getContextUsage();
			const used = actualUsage?.tokens ?? estimatedUsed;
			const bar = buildBar(ranges, contextWindow, theme, used);
			const label = theme.fg("dim", fmt(used) + "/" + fmt(contextWindow));
			lines.push(truncateToWidth(label + " │ " + bar, width));
		} else {
			lines.push(truncateToWidth(theme.fg("dim", "no model"), width));
		}

		// Line 3: extension statuses
		const statuses = footerData.getExtensionStatuses();
		if (statuses.size > 0) {
			const parts: string[] = [];
			for (const text of statuses.values()) {
				parts.push(text);
			}
			lines.push(truncateToWidth(parts.join(" │ "), width));
		}

		return lines;
	};
}

// ── Extension entry point ──────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let tuiRef: { requestRender: () => void } | undefined;

	const refresh = (_e: unknown, _ctx: ExtensionContext) => {
		tuiRef?.requestRender();
	};

	pi.on("agent_start", refresh);
	pi.on("message_update", refresh);
	pi.on("message_end", refresh);
	pi.on("model_select", refresh);

	pi.on("session_start", (_event, ctx) => {
		const renderAll = makeFooterRender(ctx);

		ctx.ui.setFooter(function (tui, theme, footerData) {
			tuiRef = tui;
			return {
				invalidate: () => {},
				render: function (width: number): string[] {
					return renderAll(tui, theme, footerData, width);
				},
			};
		});
	});
}
