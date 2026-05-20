# tokenlens-cc

Claude Code plugin that wires `tokenlens` into the `PreToolUse` and `SessionStart` hooks.

On every tool call, the plugin:
1. Reads the active session jsonl.
2. Computes billable tokens consumed (input + cache_creation + output, ignoring cheap cache_read).
3. Compares against the weekly budget configured in `~/.claude/tokenlens.json`.
4. Returns one of `allow` (silent), `allow` with a warning context message, `ask` (force user click-through), or `deny` (hard block).

Errors fail-allow — a broken hook never breaks your workflow.

## Status

**Pre-release.** This is the v2 design surface. To test locally:

```bash
# From the tokenlens repo root
pnpm install           # builds dist/ via the prepare script
claude --plugin-dir ./tokenlens-cc
```

Then run any tool inside the session and watch `~/.claude/tokenlens.log` for the decisions emitted.

## Configuration

Generate a default config:

```bash
tokenlens init --tier max5   # or pro / max20 / api
```

Edit `~/.claude/tokenlens.json` to adjust thresholds:

```json
{
  "weeklyTokenBudget": 2500000,
  "warningThresholdPercent": 50,
  "askThresholdPercent": 80,
  "blockThresholdPercent": 95,
  "hardCap": false
}
```

## Marketplace install (when available)

Will be available via the community marketplace pending review:

```
/plugin marketplace add anthropics/claude-plugins-community
/plugin install @claude-community/tokenlens
```

See [docs/V2-DESIGN.md](../docs/V2-DESIGN.md) for the full spec.
