# tokenlens

> See exactly what's eating your Claude Code context window — and stop it.

**Status: pre-alpha, week 1.** Nothing works yet. Read `DESIGN.md` for the plan.

## What this is

A local CLI that watches your `~/.claude/` state and tells you which skills, plugins, MCP servers, and re-injected files are spending your weekly token budget. Inspired by [`anthropics/claude-code` Issue #29971](https://github.com/anthropics/claude-code/issues/29971), which Anthropic closed as "not planned."

```
$ tokenlens status
Session: ~/work/foo  (started 2h ago, 14 turns)

  Skills           22,140 tokens  (3 duplicates detected — run `tokenlens doctor`)
  Plugins          18,902 tokens  (2 stale versions still in cache)
  MCP servers      14,316 tokens  (8 servers loaded, 2 actually called)
  CLAUDE.md         8,432 tokens  (re-injected 47x this session)
  History          31,008 tokens
  ─────────────────────────────────
  Total            94,798 tokens  ≈ $0.28 input + amortized
  Weekly cap        78% used      reset in 3d 5h
```

## Why

`/context` undercounts. Issue #29971 documents how. This tool counts what's actually there.

## Install (planned)

```bash
pnpm dlx tokenlens status
# or
npx tokenlens status
```

## Roadmap

See `DESIGN.md` for the full plan. Short version:

- **v1** (CLI, free, OSS): `status`, `watch`, `doctor`. Claude Code only.
- **v2** (paid sync): pre-flight cap enforcement via hooks, anonymized cross-machine sync.
- **v3**: Cursor, Cline, Gemini CLI.

## License

MIT (proposed). See `LICENSE` once added.
