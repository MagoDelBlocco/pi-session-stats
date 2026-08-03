import { test, describe } from "node:test";
import assert from "node:assert/strict";

// The functions under test are imported from core.ts — the same module the
// extension (index.ts) uses. This guarantees the tests exercise the exact
// shipped code, never a duplicated copy.
import {
	estimateMessageTokens,
	buildMessageRanges,
	dominantRange,
	segmentColor,
	buildBar,
	fmt,
	fmtTps,
	SEGMENTS,
	TokenSpeedTracker,
	renderCounters,
} from "./core.ts";

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

// Fake clock for deterministic TokenSpeedTracker tests
function makeClock() {
	let t = 0;
	return {
		now: () => t,
		advance: (ms) => {
			t += ms;
		},
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
		assert.strictEqual(tokens, Math.ceil("Hello world".length / 4));
	});

	test("estimates array content with text parts", () => {
		const msg = { content: [{ type: "text", text: "Hello" }] };
		const tokens = estimateMessageTokens(msg);
		assert.ok(tokens > 0);
	});

	test("estimates image content", () => {
		const msg = { content: [{ type: "image", source: {} }] };
		const tokens = estimateMessageTokens(msg);
		assert.strictEqual(tokens, 1200);
	});

	test("estimates toolCall content", () => {
		const msg = {
			content: [
				{ type: "text", text: "Let me read that file." },
				{ type: "toolCall", id: "tool_1", name: "read", arguments: { path: "foo.ts" } },
			],
		};
		const tokens = estimateMessageTokens(msg);
		assert.ok(tokens > 0);
	});

	test("estimates thinking content", () => {
		const msg = {
			content: [
				{ type: "text", text: "Let me think about this." },
				{ type: "thinking", thinking: "I need to consider the implications carefully." },
			],
		};
		const tokens = estimateMessageTokens(msg);
		assert.ok(tokens > 0);
	});

	test("estimates bashExecution content", () => {
		const msg = {
			role: "bashExecution",
			command: "ls -la",
			output: "total 0",
		};
		const tokens = estimateMessageTokens(msg);
		assert.strictEqual(tokens, Math.ceil(("ls -la".length + "total 0".length) / 4));
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

		const { ranges } = buildMessageRanges(entries);

		assert.strictEqual(ranges.length, 3);
		assert.strictEqual(ranges[0].type, "system");
		assert.strictEqual(ranges[1].type, "user");
		assert.strictEqual(ranges[2].type, "assistant");
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
		const { ranges } = buildMessageRanges([]);
		assert.strictEqual(ranges.length, 0);
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

		const bar = buildBar(ranges, 100000, theme, 1000);
		// Each segment is one symbol with ANSI codes, count the symbols
		const symbolCount = (bar.match(/⏥/g) || []).length;
		assert.strictEqual(symbolCount, SEGMENTS);
	});

	test("fills segments proportionally to usage", () => {
		// 5000 tokens used out of 100000 = 5% = 2.5 segments → ceil = 3
		const ranges = [{ start: 0, end: 5000, type: "system" }];
		const bar = buildBar(ranges, 100000, theme, 5000);

		const filledCount = (bar.match(/\[ACCENT:/g) || []).length;
		assert.strictEqual(filledCount, 3);
	});

	test("never applies a background to any segment", () => {
		const ranges = [
			{ start: 0, end: 90000, type: "assistant" },
			{ start: 90000, end: 90100, type: "user" },
			{ start: 90100, end: 100000, type: "assistant" },
		];

		const bar = buildBar(ranges, 200000, theme, 100000);
		assert.ok(!bar.includes("{customMessageBg:"), "bar must not set any background");
	});

	test("last lit segment is colored, never a dim hole", () => {
		// used = 13829 of 200000 → 4 lit segments. The 4th segment's old
		// midpoint (14000) fell past `used` and rendered dim; it must not.
		const ranges = [
			{ start: 0, end: 3000, type: "system" },
			{ start: 3000, end: 13829, type: "tool", toolName: "read" },
		];
		const bar = buildBar(ranges, 200000, theme, 13829);

		// 4 lit segments, all read/system colored, zero dim among the first 4.
		const dim = (bar.match(/\[DIM:⏥\]/g) || []).length;
		assert.strictEqual(dim, SEGMENTS - 4, "only unused segments are dim");
	});

	test("reverses lit order: leftmost lit segment is the most recent span", () => {
		// system occupies [0,4000) (oldest), read occupies [4000,8000) (newest).
		// 8000 used of 100000 → 4 lit segments. With the reversal, the most
		// recent (read) span lands on the LEFT, oldest (system) at the boundary.
		const ranges = [
			{ start: 0, end: 4000, type: "system" },
			{ start: 4000, end: 8000, type: "tool", toolName: "read" },
		];
		const bar = buildBar(ranges, 100000, theme, 8000);
		const symbols = bar.match(/\[[A-Z]+:⏥\]/g) || [];
		assert.strictEqual(symbols[0], "[WARNING:⏥]", "leftmost lit = newest (read)");
		assert.strictEqual(symbols[3], "[ACCENT:⏥]", "boundary lit = oldest (system)");
	});

	test("leaves empty segments dim", () => {
		const ranges = [{ start: 0, end: 1000, type: "system" }];
		const bar = buildBar(ranges, 100000, theme, 1000);

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

		const { ranges } = buildMessageRanges(entries);
		const theme = makeMockTheme();
		const used = ranges.length > 0 ? ranges[ranges.length - 1].end : 0;
		const bar = buildBar(ranges, 200000, theme, used);

		assert.ok(bar.includes("[ACCENT:"), "should have system segments");
		assert.ok(bar.includes("[WARNING:"), "should have read tool segments");
		assert.ok(bar.includes("[DIM:"), "should have empty segments");
		assert.ok(!bar.includes("{customMessageBg:"), "bar must not set any background");
	});
});

describe("TokenSpeedTracker", () => {
	test("measures time to first token (TTFT)", () => {
		const clock = makeClock();
		const tr = new TokenSpeedTracker(1000, clock.now);
		tr.startUser(); // t=0
		clock.advance(320);
		tr.firstContent(); // t=320
		assert.strictEqual(tr.ttftMs, 320);
	});

	test("live decode TPS uses a sliding window of provider-reported output", () => {
		const clock = makeClock();
		const tr = new TokenSpeedTracker(1000, clock.now);
		tr.startUser();
		tr.assistantStart();
		tr.firstContent(1000); // stream starts, baseline output=1000
		// 40 output tokens over 400ms → ~100 tok/s
		for (let i = 1; i <= 40; i++) {
			clock.advance(10);
			tr.delta(1000 + i);
		}
		assert.ok(tr.isStreaming, "stream is in progress");
		assert.ok(tr.decodeTps > 60, "decode rate is elevated");
		assert.ok(tr.decodeTps < 150, "window smooths to ~100 tok/s");
	});

	test("reconciles decode total to authoritative usage at message end", () => {
		const clock = makeClock();
		const tr = new TokenSpeedTracker(1000, clock.now);
		tr.startUser();
		tr.assistantStart();
		tr.firstContent(0); // t=0, stream starts
		clock.advance(2000);
		tr.assistantEnd(80); // 80 output tokens over 2s
		assert.strictEqual(tr.decodeTpsAvg, 40);
		assert.strictEqual(tr.isStreaming, false);
	});

	test("reset on a new user message clears prior turn counters", () => {
		const clock = makeClock();
		const tr = new TokenSpeedTracker(1000, clock.now);
		tr.startUser();
		tr.assistantStart();
		tr.firstContent(0);
		clock.advance(2000);
		tr.assistantEnd(80);
		assert.strictEqual(tr.decodeTpsAvg, 40);

		tr.startUser(); // new turn resets state
		assert.strictEqual(tr.ttftMs, 0);
		assert.strictEqual(tr.decodeTpsAvg, 0);
	});

	test("keeps thinking tokens in decode when text_start follows thinking_start", () => {
		const clock = makeClock();
		const tr = new TokenSpeedTracker(1000, clock.now);
		tr.startUser(); // t=0
		clock.advance(300);
		tr.assistantStart();
		// thinking phase
		tr.firstContent(0); // thinking_start, baseline output 0
		clock.advance(100);
		tr.delta(30); // 30 thinking tokens
		clock.advance(100);
		tr.delta(60); // 60 thinking tokens cumulative
		// text phase begins — text_start fires firstContent again
		tr.firstContent(60); // must NOT wipe the thinking window
		clock.advance(100);
		tr.delta(70); // 10 text tokens → 70 total
		assert.strictEqual(tr.isStreaming, true);
		// 70 tokens (thinking + text) over the window → far above a text-only rate
		assert.ok(tr.decodeTps > 100, "decode reflects thinking + text, not just text");
		assert.ok(tr.decodeTps < 400, "decode bounded by ~70 total tokens over the window");
	});
});

describe("fmtTps", () => {
	test("truncates to exactly 2 decimal places without rounding", () => {
		assert.strictEqual(fmtTps(25.258323765786454), "25.25");
		assert.strictEqual(fmtTps(49.62546816479401), "49.62");
		assert.strictEqual(fmtTps(6666.666666666667), "6666.66");
	});

	test("always shows two decimal places", () => {
		assert.strictEqual(fmtTps(50), "50.00");
		assert.strictEqual(fmtTps(5), "5.00");
		assert.strictEqual(fmtTps(0), "0.00");
	});

	test("handles floating-point values robustly", () => {
		assert.strictEqual(fmtTps(0.03), "0.03");
		assert.strictEqual(fmtTps(0.1), "0.10");
		assert.strictEqual(fmtTps(0.07), "0.07");
	});
});

describe("renderCounters", () => {
	test("returns empty string when there is no data", () => {
		const theme = makeMockTheme();
		const clock = makeClock();
		const tr = new TokenSpeedTracker(1000, clock.now);
		assert.strictEqual(renderCounters(tr, theme), "");
	});

	test("renders TTFT and decode to the right of the bar", () => {
		const theme = makeMockTheme();
		const clock = makeClock();
		const tr = new TokenSpeedTracker(1000, clock.now);
		tr.startUser(); // t=0
		clock.advance(300);
		tr.firstContent(0);
		clock.advance(1000);
		tr.assistantEnd(50); // decode = 50 / 1s = 50

		const s = renderCounters(tr, theme);
		assert.ok(s.includes("ttft 300ms"), "shows TTFT");
		assert.ok(s.includes("decode 50.00/s"), "shows decode truncated to 2 decimals");
		assert.ok(!s.includes("prefill"), "prefill counter removed");
	});

	test("uses the live sliding-window decode rate while streaming", () => {
		const theme = makeMockTheme();
		const clock = makeClock();
		const tr = new TokenSpeedTracker(1000, clock.now);
		tr.startUser();
		tr.assistantStart();
		tr.firstContent(1000);
		for (let i = 1; i <= 40; i++) {
			clock.advance(10);
			tr.delta(1000 + i);
		}
		const s = renderCounters(tr, theme);
		assert.ok(s.includes("decode "), "shows decode while streaming");
	});
});
