/**
 * Context Bar Footer — replaces the pi footer with a horizontal bar
 * visualizing context window usage by message type.
 *
 * The token-estimation and bar-building math lives in core.ts (shared with
 * the test suite so both stay in parity). This file wires it into the pi
 * extension API: a footer that renders the cwd, the context bar, and any
 * extension statuses.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { buildMessageRanges, buildBar, fmt, TokenSpeedTracker, renderCounters } from "./core.ts";

// ── Footer renderer factory ────────────────────────────────────────

function makeFooterRender(ctx: ExtensionContext, tracker: TokenSpeedTracker) {
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
			lines.push(truncateToWidth(label + " │ " + bar + renderCounters(tracker, theme), width));
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

// ── Token-speed event handlers ─────────────────────────────────────

interface StreamMessageEvent {
	message?: { role?: string; usage?: { output?: number } };
	assistantMessageEvent?: { type?: string };
}

function handleMessageStart(tracker: TokenSpeedTracker, event: unknown): void {
	const msg = (event as StreamMessageEvent).message;
	if (!msg) return;
	if (msg.role === "user") {
		tracker.startUser();
	} else if (msg.role === "assistant") {
		tracker.assistantStart();
	}
}

function handleMessageUpdate(tracker: TokenSpeedTracker, event: unknown): void {
	const e = event as StreamMessageEvent;
	const type = e.assistantMessageEvent?.type;
	const output = e.message?.usage?.output;
	if (type === "text_start" || type === "thinking_start" || type === "toolcall_start") {
		tracker.firstContent(output);
	}
	tracker.delta(output);
}

function handleMessageEnd(tracker: TokenSpeedTracker, event: unknown): void {
	const msg = (event as StreamMessageEvent).message;
	if (msg?.role === "assistant") {
		tracker.assistantEnd(msg.usage?.output);
	}
}

// ── Extension entry point ──────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let tuiRef: { requestRender: () => void } | undefined;
	const tracker = new TokenSpeedTracker();

	const refresh = (_e: unknown, _ctx: ExtensionContext) => {
		tuiRef?.requestRender();
	};

	pi.on("agent_start", refresh);
	pi.on("model_select", refresh);

	// Token-speed tracking over the streaming lifecycle.
	pi.on("message_start", (event) => {
		handleMessageStart(tracker, event);
	});
	pi.on("message_update", (event) => {
		handleMessageUpdate(tracker, event);
		tuiRef?.requestRender();
	});
	pi.on("message_end", (event) => {
		handleMessageEnd(tracker, event);
		tuiRef?.requestRender();
	});

	pi.on("session_start", (_event, ctx) => {
		const renderAll = makeFooterRender(ctx, tracker);

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
