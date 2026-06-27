# pi-session-stats

A [pi](https://github.com/earendil-works/pi-coding-agent) extension that replaces the default footer with a color-coded context window visualization bar.

See at a glance how your context budget is spent across message types and which tools are consuming the most tokens.

## Features

- **Context usage bar** — 50 segments (⏥), each representing 2% of the context window
- **Per-message coloring** — each segment colored by the majority content type in that range
- **Tool differentiation** — `read` tool output in yellow, other tools in red
- **Most-recent-first layout** — lit segments run newest → oldest from the left, with unused context dim on the right
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
┌────────────────────────────────────────────────────┐
│ /home/bogdan/project                               │  ← cwd (blue bg + text)
│ 14k/262k │ ⏥⏥⏥⏥⏥⏥⏥⏥⏥⏥⏥⏥⏥⏥⏥⏥⏥⏥⏥⏥⏥⏥⏥⏥⏥⏥⏥⏥⏥⏥⏥⏥⏥⏥⏥⏥⏥⏥⏥⏥⏥⏥ │  ← context bar
│ mcp-client: connected  cycle-detection: shadow     │  ← other extension statuses
└────────────────────────────────────────────────────┘
```

## Installation

This extension is auto-discovered when placed in your pi extensions directory:

```
~/.pi/agent/extensions/session-stats/
```

No additional configuration or dependencies required.

## Token Estimation

Token counts are estimated using a bytes/4 heuristic per message content. This is approximate but sufficient for visualization purposes. Actual token counts from the provider may differ slightly.

## Testing

```bash
node test.mjs
```

## License

MIT — see [LICENSE](LICENSE)