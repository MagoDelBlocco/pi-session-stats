import { test, describe } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Inline the functions under test (mirrors index.ts logic)
// ---------------------------------------------------------------------------

const SEGMENTS = 50;
const SYMBOL = "⏥";
const encoder = new TextEncoder();

function estimateMessageTokens(message) {
	const content = message.content;

	if (typeof content === "string") {
		return Math.ceil(encoder.encode(content).length / 4);
	}

	if (!Array.isArray(content)) {
		return 0;
	}

	let bytes = 0;

	for (const part of content) {
		if (part.type === "text") {
			bytes += encoder.encode(part.text ?? "").length;
		} else if (part.type === "image") {
			bytes += 768 * 4;
		} else if (part.type === "tool_use") {
			bytes += encoder.encode(JSON.stringify(part)).length;
		}
	}

	return Math.ceil(bytes / 4);
}

function buildMessageRanges(entries) {
	const ranges = [];
	let cursor = 0;
	let lastUserStart = Infinity;

	for (const entry of entries) {
		if (entry.type !== "message") continue;

		const msg = entry.message;
		const tokens = estimateMessageTokens(msg);
		if (tokens === 0) continue;

		const role = msg.role;
		let type = "assistant";
		let toolName;

		if (role === "system") {
			type = "system";
		} else if (role === "user") {
			type = "user";
			lastUserStart = cursor;
		} else if (role === "assistant") {
			type = "assistant";
		} else if (role === "tool" || role === "toolResult") {
			type = "tool";
			toolName = typeof msg.toolName === "string" ? msg.toolName : undefined;
		}

		ranges.push({ start: cursor, end: cursor + tokens, type, toolName });
		cursor += tokens;
	}

	return { ranges, lastUserStart };
}

function dominantRange(ranges, lo, hi) {
	let best;
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

function segmentColor(range, theme) {
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

function buildBar(ranges, contextWindow, lastUserStart, theme) {
	const used = ranges.length > 0 ? ranges[ranges.length - 1].end : 0;
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

		const lo = i * tokensPerSegment;
		const hi = Math.min((i + 1) * tokensPerSegment, used);
		const range = dominantRange(ranges, lo, hi);
		const color = range ? segmentColor(range, theme) : emptySymbol;

		if (hi > lastUserStart) {
			bar += theme.bg("customMessageBg", color);
		} else {
			bar += color;
		}
	}

	return bar;
}

function fmt(n) {
	if (n < 1000) return `${n}`;
	if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
	return `${(n / 1_000_000).toFixed(1)}m`;
}

// Mock theme for testing
function makeMockTheme() {
	const colors = {
		dim: "DIM",
		accent: "ACCENT",
		success: "SUCCESS",
		warning: "WARNING",
		error: "ERROR",
	};

	return {
		fg: (color, text) => `[${colors[color] || color}:${text}]`,
		bg: (bg, text) => `{${bg}:${text}}`,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("estimateMessageTokens", () => {
	test("estimates string content", () => {
		const msg = { content: "Hello world" };
		const tokens = estimateMessageTokens(msg);
		assert.ok(tokens > 0, "should estimate positive tokens");
		assert.strictEqual(tokens, Math.ceil(encoder.encode("Hello world").length / 4));
	});

	test("estimates array content with text parts", () => {
		const msg = { content: [{ type: "text", text: "Hello" }] };
		const tokens = estimateMessageTokens(msg);
		assert.ok(tokens > 0);
	});

	test("estimates image content", () => {
		const msg = { content: [{ type: "image", source: {} }] };
		const tokens = estimateMessageTokens(msg);
		assert.strictEqual(tokens, 768);
	});

	test("estimates tool_use content", () => {
		const msg = {
			content: [
				{ type: "text", text: "Let me read that file." },
				{ type: "tool_use", id: "tool_1", name: "read", input: { path: "foo.ts" } },
			],
		};
		const tokens = estimateMessageTokens(msg);
		assert.ok(tokens > 0);
	});

	test("returns 0 for empty content", () => {
		assert.strictEqual(estimateMessageTokens({ content: null }), 0);
		assert.strictEqual(estimateMessageTokens({ content: undefined }), 0);
	});
});

describe("buildMessageRanges", () => {
	test("builds ranges from entries in order", () => {
		const entries = [
			{ type: "message", message: { role: "system", content: "You are a helpful assistant." } },
			{ type: "message", message: { role: "user", content: "Hello" } },
			{ type: "message", message: { role: "assistant", content: "Hi there!" } },
		];

		const { ranges, lastUserStart } = buildMessageRanges(entries);

		assert.strictEqual(ranges.length, 3);
		assert.strictEqual(ranges[0].type, "system");
		assert.strictEqual(ranges[1].type, "user");
		assert.strictEqual(ranges[2].type, "assistant");
		assert.ok(Number.isFinite(lastUserStart), "lastUserStart should be set");
	});

	test("tracks last user message start position", () => {
		const entries = [
			{ type: "message", message: { role: "system", content: "System prompt here." } },
			{ type: "message", message: { role: "user", content: "First message" } },
			{ type: "message", message: { role: "assistant", content: "Response" } },
			{ type: "message", message: { role: "user", content: "Second message" } },
			{ type: "message", message: { role: "assistant", content: "Final response" } },
		];

		const { lastUserStart } = buildMessageRanges(entries);
		const sysTokens = estimateMessageTokens({ role: "system", content: "System prompt here." });
		const user1Tokens = estimateMessageTokens({ role: "user", content: "First message" });
		const assistant1Tokens = estimateMessageTokens({ role: "assistant", content: "Response" });

		// start of the SECOND user message = everything before it
		assert.strictEqual(lastUserStart, sysTokens + user1Tokens + assistant1Tokens);
	});

	test("identifies tool messages with tool names", () => {
		const entries = [
			{ type: "message", message: { role: "toolResult", toolName: "read", content: "file contents here" } },
			{ type: "message", message: { role: "toolResult", toolName: "bash", content: "command output" } },
		];

		const { ranges } = buildMessageRanges(entries);

		assert.strictEqual(ranges[0].type, "tool");
		assert.strictEqual(ranges[0].toolName, "read");
		assert.strictEqual(ranges[1].type, "tool");
		assert.strictEqual(ranges[1].toolName, "bash");
	});

	test("skips non-message entries", () => {
		const entries = [
			{ type: "custom", data: { foo: "bar" } },
			{ type: "message", message: { role: "user", content: "Hello" } },
		];

		const { ranges } = buildMessageRanges(entries);
		assert.strictEqual(ranges.length, 1);
	});

	test("handles empty entries", () => {
		const { ranges, lastUserStart } = buildMessageRanges([]);
		assert.strictEqual(ranges.length, 0);
		assert.strictEqual(lastUserStart, Infinity);
	});
});

describe("dominantRange", () => {
	const ranges = [
		{ start: 0, end: 100, type: "system" },
		{ start: 100, end: 200, type: "user" },
		{ start: 200, end: 300, type: "assistant" },
	];

	test("picks the range covering most of the span", () => {
		// span [90,160): 10 of system, 60 of user → user wins
		assert.strictEqual(dominantRange(ranges, 90, 160).type, "user");
	});

	test("picks a small range when it dominates a narrow span", () => {
		assert.strictEqual(dominantRange(ranges, 110, 140).type, "user");
	});

	test("returns undefined when span overlaps nothing", () => {
		assert.strictEqual(dominantRange(ranges, 400, 500), undefined);
		assert.strictEqual(dominantRange([], 0, 100), undefined);
	});
});

describe("segmentColor", () => {
	const theme = makeMockTheme();

	test("colors system as accent", () => {
		assert.strictEqual(segmentColor({ type: "system" }, theme), "[ACCENT:⏥]");
	});

	test("colors user as success", () => {
		assert.strictEqual(segmentColor({ type: "user" }, theme), "[SUCCESS:⏥]");
	});

	test("colors assistant as success", () => {
		assert.strictEqual(segmentColor({ type: "assistant" }, theme), "[SUCCESS:⏥]");
	});

	test("colors read tool as warning", () => {
		assert.strictEqual(
			segmentColor({ type: "tool", toolName: "read" }, theme),
			"[WARNING:⏥]",
		);
	});

	test("colors other tools as error", () => {
		assert.strictEqual(
			segmentColor({ type: "tool", toolName: "bash" }, theme),
			"[ERROR:⏥]",
		);
		assert.strictEqual(
			segmentColor({ type: "tool", toolName: "edit" }, theme),
			"[ERROR:⏥]",
		);
		assert.strictEqual(
			segmentColor({ type: "tool" }, theme),
			"[ERROR:⏥]",
		);
	});
});

describe("buildBar", () => {
	const theme = makeMockTheme();

	test("produces correct number of segments", () => {
		const ranges = [
			{ start: 0, end: 1000, type: "system" },
		];

		const bar = buildBar(ranges, 100000, 0, theme);
		// Each segment is one symbol with ANSI codes, count the symbols
		const symbolCount = (bar.match(/⏥/g) || []).length;
		assert.strictEqual(symbolCount, SEGMENTS);
	});

	test("fills segments proportionally to usage", () => {
		// 5000 tokens used out of 100000 = 5% = 2.5 segments → ceil = 3
		const ranges = [{ start: 0, end: 5000, type: "system" }];
		const bar = buildBar(ranges, 100000, 0, theme);

		const filledCount = (bar.match(/\[ACCENT:/g) || []).length;
		assert.strictEqual(filledCount, 3);
	});

	test("backgrounds only the current round, not the whole bar", () => {
		// 100k used of 200k → 25 lit segments. Last user message starts at
		// 90k, so only the final ~5 segments are the current round.
		const ranges = [
			{ start: 0, end: 90000, type: "assistant" },
			{ start: 90000, end: 90100, type: "user" },
			{ start: 90100, end: 100000, type: "assistant" },
		];

		const bar = buildBar(ranges, 200000, 90000, theme);
		const bgCount = (bar.match(/\{customMessageBg:/g) || []).length;
		const litCount = (bar.match(/⏥/g) || []).length - (bar.match(/\[DIM:⏥\]/g) || []).length;

		assert.ok(bgCount > 0, "current round should be highlighted");
		assert.ok(bgCount < litCount, "background must not cover every lit segment");
	});

	test("no background when there is no user message yet", () => {
		const ranges = [{ start: 0, end: 5000, type: "system" }];
		const bar = buildBar(ranges, 100000, Infinity, theme);
		assert.ok(!bar.includes("{customMessageBg:"), "nothing before the first user msg");
	});

	test("last lit segment is colored, never a dim hole", () => {
		// used = 13829 of 200000 → 4 lit segments. The 4th segment's old
		// midpoint (14000) fell past `used` and rendered dim; it must not.
		const ranges = [
			{ start: 0, end: 3000, type: "system" },
			{ start: 3000, end: 13829, type: "tool", toolName: "read" },
		];
		const bar = buildBar(ranges, 200000, 0, theme);

		// 4 lit segments, all read/system colored, zero dim among the first 4.
		const dim = (bar.match(/\[DIM:⏥\]/g) || []).length;
		assert.strictEqual(dim, SEGMENTS - 4, "only unused segments are dim");
	});

	test("leaves empty segments dim", () => {
		const ranges = [{ start: 0, end: 1000, type: "system" }];
		const bar = buildBar(ranges, 100000, 0, theme);

		assert.ok(bar.includes("[DIM:⏥]"), "should have dim empty segments");
	});
});

describe("fmt", () => {
	test("formats small numbers", () => {
		assert.strictEqual(fmt(0), "0");
		assert.strictEqual(fmt(999), "999");
	});

	test("formats thousands", () => {
		assert.strictEqual(fmt(1000), "1k");
		assert.strictEqual(fmt(1500), "2k");
		assert.strictEqual(fmt(14000), "14k");
		assert.strictEqual(fmt(999500), "1000k");
	});

	test("formats millions", () => {
		assert.strictEqual(fmt(1_000_000), "1.0m");
		assert.strictEqual(fmt(1_500_000), "1.5m");
	});
});

describe("integration: full pipeline", () => {
	test("renders a realistic session", () => {
		const entries = [
			{ type: "message", message: { role: "system", content: "A".repeat(20000) } },
			{ type: "message", message: { role: "user", content: "Read the file" } },
			{ type: "message", message: { role: "assistant", content: "Let me do that." } },
			{ type: "message", message: { role: "toolResult", toolName: "read", content: "B".repeat(50000) } },
			{ type: "message", message: { role: "assistant", content: "Here is the content." } },
		];

		const { ranges, lastUserStart } = buildMessageRanges(entries);
		const theme = makeMockTheme();
		const bar = buildBar(ranges, 200000, lastUserStart, theme);

		assert.ok(bar.includes("[ACCENT:"), "should have system segments");
		assert.ok(bar.includes("[WARNING:"), "should have read tool segments");
		assert.ok(bar.includes("[DIM:"), "should have empty segments");
		assert.ok(bar.includes("{customMessageBg:"), "should have background for last round");
	});
});