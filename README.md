# pi-session-stats

A [pi](https://github.com/earendil-works/pi-coding-agent) extension that replaces the default footer with a color-coded context window visualization bar.

See at a glance how your context budget is spent across message types and which tools are consuming the most tokens.

## Features

- **Context usage bar** — 50 segments (⏥), each representing 2% of the context window
- **Per-message coloring** — each segment colored by the majority content type in that range
- **Tool differentiation** — `read` tool output in yellow, other tools in red
- **Most-recent-first layout** — lit segments run newest → oldest from the left, with unused context dim on the right
- **Token-speed counters** — TTFT and decode tokens-per-second to the right of the context bar (wall-clock timing over streaming events + provider-reported usage)
- **Extension status passthrough** — preserves status widgets from other extensions
- **Live updates** — auto-refreshes on agent start, message streaming, and model changes

## Color Legend

| Color | Meaning |
| ----- | ------- |
| 🔵 blue (`accent`) | System prompt |
| 🟢 green (`success`) | User / assistant messages |
| 🟡 yellow (`warning`) | `read` tool output |
| 🔴 red (`error`) | Other tool output (`bash`, `edit`, `write`, etc.) |
| ⚫ dim | Unused context |

## Layout

```
┌────────────────────────────────────────────────────────────────────────┐
│ /home/bogdan/project                                                   │  ← cwd (blue bg + text)
│ 14k/262k │ ⏥⏥⏥⏥⏥⏥⏥⏥⏥⏥⏥⏥⏥⏥⏥ │ ttft 320ms · decode 42/s │  ← context bar + counters
│ mcp-client: connected  cycle-detection: shadow                         │  ← other extension statuses
└────────────────────────────────────────────────────────────────────────┘
```

## Installation

This extension is auto-discovered when placed in your pi extensions directory:

```
~/.pi/agent/extensions/session-stats/
```

No additional configuration or dependencies required.

## Token Speed

The two counters to the right of the context bar are measured from wall-clock
`Date.now()` timestamps over the streaming lifecycle, combined with
provider-reported token usage:

| Counter | How it's measured |
| ------- | ----------------- |
| **TTFT** | ms from the user message (`message_start`) to the first content block (`text_start`/`thinking_start`/`toolcall_start`) |
| **Decode** | `usage.output` accumulated during streaming via a 1s sliding window; reconciled to the authoritative `usage.output` at `message_end` |

Decode shows the live sliding-window rate while streaming, then the reconciled
average once the message completes. The sliding-window size defaults to 1000ms.

Decode counts **all** generated output tokens, including any `<thinking>`/
reasoning traces, since providers report them together in `usage.output` — the
decode window is not reset when the model switches from thinking to visible text.

> Note: streaming `usage.output` is provider-reported. Anthropic reports output
> during streaming; OpenAI-compatible providers (e.g. llama.cpp) typically report
> usage only at the end, in which case live decode shows 0 until the final
> reconciled value lands at `message_end`.

## Token Estimation

Token counts are estimated using a bytes/4 heuristic per message content. This is approximate but sufficient for visualization purposes. Actual token counts from the provider may differ slightly.

## Testing

```bash
node test.mjs
```

## License

MIT — see [LICENSE](LICENSE)