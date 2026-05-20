# tokenlens

[![ci](https://github.com/bouncei/tokenlens/actions/workflows/ci.yml/badge.svg)](https://github.com/bouncei/tokenlens/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Node.js](https://img.shields.io/badge/node-%E2%89%A520-green)](https://nodejs.org)

**See exactly what's eating your Claude Code context window — and stop it.**

```bash
npx -y github:bouncei/tokenlens status
```

That's the install. No clone, no build, no config.

---

## Why this exists

Claude Code's built-in `/context` is [documented](https://github.com/anthropics/claude-code/issues/29971) to undercount MCP overhead by ~40k tokens per session. Anthropic was asked to fix it in March 2026 and closed the issue as "not planned." That's the wedge: the vendor's interest is to keep token consumption opaque to maximize per-user revenue; yours is to see exactly where your $200/mo Claude Max budget goes.

`tokenlens` is aligned with your wallet, not theirs.

## What you actually see

Run against my live session as I'm writing this:

```
$ tokenlens status
tokenlens status
  session  ~/.claude/projects/-Users-josh-tokenlens/abc.jsonl
  turns    263 assistant

Tokens consumed by Anthropic
  input (uncached)           38.9k
  cache writes               2.06M   ← bloat lives here
  cache reads               40.14M   ← cheap
  output                    293.7k
  cache hit rate             95.1%

Output by attributionSkill
  <unattributed>          ████████████████   201.2k   (198 turns)
  idea-scout              ███████░░░░░░░░░    92.6k   (65 turns)

Injected context by source
  (share-by-weight, capped at 1.5x estimated size; residual goes
   to cache_invalidation_or_growth. ~ = heuristic for text-less)
  deferred_tools_added          █░░░░░░░░░░░░░░░ ~  25.0k   3 ev, 0 B text
  skill_listing                 ░░░░░░░░░░░░░░░░     1.5k   1 ev, 13.3 KB text
  todo_reminder                 ░░░░░░░░░░░░░░░░ ~    825   11 ev, 0 B text
  hook_additional_context       ░░░░░░░░░░░░░░░░      791   1 ev, 5.5 KB text
  cache_invalidation_or_growth  ████████████████ ! 518.2k   across 15 turns
```

That last line is the punchline. Over the course of this session, **518k tokens were written to cache as part of invalidations that Anthropic's own `/context` won't surface**. That's roughly $4 of cache-write cost on Opus, paid silently across 15 separate moments. `tokenlens` names it.

## Three commands

### `tokenlens status`

One-shot breakdown of the active session. Reports Anthropic's exact per-turn usage from `message.usage`, attribution by `attributionSkill`, and a share-by-weight breakdown of which injected sources contributed to cache writes. A separate `cache_invalidation_or_growth` bucket captures cache writes that can't reasonably be tied to any visible attachment.

Flags:
- `--cwd <path>` — resolve the active session for a different working directory
- `--session <file>` — read a specific `.jsonl` directly

### `tokenlens watch`

Same view as `status`, refreshed live as the session log grows. Useful to keep open in a side terminal while you work.

```bash
tokenlens watch
```

Press ctrl-c to stop.

### `tokenlens doctor`

Detects (and optionally fixes) the two pathologies most commonly responsible for hidden context growth per Issue #29971:

1. **Stale plugin versions** — `~/.claude/plugins/cache/<source>/<plugin>/` directories still holding previous versions of installed plugins.
2. **Duplicate skill symlinks** — `~/.claude/skills/` symlinks pointing to the same canonical target, doubling injection of the same skill.

Default is dry-run; pass `--fix` to actually remove. Every deletion is logged with full path, and the tool refuses to touch anything outside `~/.claude/`.

```bash
tokenlens doctor          # report only
tokenlens doctor --fix    # actually delete
```

## How it works

`tokenlens` reads `~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl`. The session log already contains Anthropic's ground-truth per-turn token counts, so for past turns `tokenlens` reports exact numbers — not estimates.

Each line is a JSON object representing one event in the session. The relevant fields:

- `type: "assistant"` rows contain `message.usage`: Anthropic's exact per-turn token count (input, cache_creation, cache_read, output, including the ephemeral_5m vs ephemeral_1h cache split).
- `attributionSkill` on each assistant row identifies which skill Anthropic attributed the turn to.
- `type: "attachment"` rows include the literal content of injected skills, hook context, todo reminders, and MCP-server tool deltas.

We aggregate these, share-out each turn's cache_creation across the attachments that preceded it (weighted by tokenized content size, or a heuristic for text-less injections), and cap per-event attribution at 1.5× weight so cache invalidations don't get falsely pinned on whatever attachment happened to be most recent.

Full schema notes in [`docs/SCHEMA.md`](./docs/SCHEMA.md). The project's north star is [`docs/GOAL.md`](./docs/GOAL.md).

## Install (other paths)

The fastest install is `npx`, but if you want a stable binary on `$PATH`:

```bash
# Globally
pnpm add -g github:bouncei/tokenlens
# or
npm install -g github:bouncei/tokenlens

# From source
git clone https://github.com/bouncei/tokenlens.git
cd tokenlens
pnpm install      # also builds dist/ via the prepare script
./dist/index.js status
```

Once published to npm:

```bash
npx tokenlens status
```

Requires Node.js 20 or newer.

## Roadmap

- **v1 (this release):** CLI `status`, `watch`, `doctor`. Free, OSS.
- **v2 (next 90 days):** Pre-flight hook into Claude Code's `PreToolUse` — "this turn will cost X tokens, Y% of your weekly cap — proceed?" Hard-cap sessions. Auto-disable MCP servers never called this session. macOS menu-bar app. Free tier stays free; paid tier ($9–19/mo) adds cross-machine sync, weekly digest, team views.
- **v3 (next 12 months):** Same value prop, cross-IDE. Cursor, Cline, Gemini CLI.

See [`docs/GOAL.md`](./docs/GOAL.md) for the full project goal and anti-goals.

## Caveats

- Reverse-engineered against Claude Code v2.1.138 (May 2026). The session jsonl schema may shift on subsequent versions; tokenlens preserves unknown fields and won't crash on them.
- The local tokenizer (`@anthropic-ai/tokenizer`) tracks the Claude 2 era. Estimates for content we tokenize locally are ±5% vs. server-side counts. **Past-turn numbers from `message.usage` are exact.**
- The `cache_invalidation_or_growth` bucket lumps together genuine cache TTL expirations and conversation growth — tokenlens can't yet distinguish them without more session signal. Working on it.

## Contributing

Issues and PRs welcome. The project is small and the surface is well-bounded — start with [`docs/SCHEMA.md`](./docs/SCHEMA.md) to understand the session jsonl format, then [`docs/GOAL.md`](./docs/GOAL.md) to understand which features are in scope vs. explicit anti-goals.

If your `~/.claude/` has a structure tokenlens doesn't recognize, please open an issue with a sample line (anonymized) — every new attachment type we map deepens the wedge.

## License

MIT — see [`LICENSE`](./LICENSE).
