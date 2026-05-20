# tokenlens

> See exactly what's eating your Claude Code context window — and stop it.

A local CLI that reads your `~/.claude/projects/<cwd>/*.jsonl` session log
and shows you precisely which skills, plugins, MCP servers, and re-injected
files are spending your weekly token budget. Inspired by
[`anthropics/claude-code` Issue #29971](https://github.com/anthropics/claude-code/issues/29971),
which Anthropic closed as "not planned."

The session jsonl already contains Anthropic's ground-truth `message.usage`
per turn, so for past turns tokenlens reports exact numbers — not estimates.

**Status:** v0.0.1, working end-to-end. Show HN ready.

## What it does

```
$ tokenlens status
tokenlens status
  session  ~/.claude/projects/-Users-josh-foo/abc.jsonl
  turns    151 assistant

Tokens consumed by Anthropic
  input (uncached)           38.7k
  cache writes              969.3k   ← bloat lives here
  cache reads               16.88M   ← cheap
  output                    194.0k
  cache hit rate             94.6%

Output by attributionSkill
  idea-scout              ████████████████    92.6k   (65 turns)
  <unattributed>          ███████████████░    87.9k   (79 turns)

Injected context by source
  (share-by-weight, capped at 1.5x estimated size; residual goes
   to cache_invalidation_or_growth. ~ = heuristic for text-less)
  deferred_tools_added          █░░░░░░░░░░░░░░░ ~  21.2k   2 ev, 0 B text
  skill_listing                 ░░░░░░░░░░░░░░░░     1.5k   1 ev, 13.3 KB text
  hook_additional_context       ░░░░░░░░░░░░░░░░      791   1 ev, 5.5 KB text
  cache_invalidation_or_growth  ████████████████ ! 302.3k   across 12 turns
```

## Install

Requires Node.js 20+. From source:

```bash
git clone https://github.com/bouncei/tokenlens.git
cd tokenlens
pnpm install
pnpm build
node ./dist/index.js status
```

Once published to npm:

```bash
pnpm dlx tokenlens status   # or: npx tokenlens status
```

## Commands

### `tokenlens status`

One-shot breakdown of the active session for the current working directory.
Reports Anthropic's exact per-turn usage, attribution by `attributionSkill`,
and a share-by-weight breakdown of which injected sources contributed to
cache writes. A separate `cache_invalidation_or_growth` bucket captures
cache_creation that can't reasonably be tied to a visible attachment (e.g.,
TTL expiries, history growth).

Flags:
- `--cwd <path>` — resolve the active session for a different working directory
- `--session <file>` — read a specific `.jsonl` directly

### `tokenlens watch`

Same view as `status`, refreshed live as the session log grows. Useful to
keep open in a side terminal while you work.

```bash
tokenlens watch
```

Press ctrl-c to stop.

### `tokenlens doctor`

Detects (and optionally fixes) the two pathologies most commonly responsible
for hidden context growth per Issue #29971:

1. **Stale plugin versions** — `~/.claude/plugins/cache/<source>/<plugin>/`
   directories that still contain previous versions of installed plugins.
2. **Duplicate skill symlinks** — `~/.claude/skills/` symlinks pointing to
   the same canonical target, doubling injection of the same skill.

Default is dry-run; pass `--fix` to actually remove. Every deletion is
logged with full path, and the tool refuses to touch anything outside
`~/.claude/`.

```bash
tokenlens doctor          # report only
tokenlens doctor --fix    # actually delete
```

## Why this exists

`/context` in Claude Code is documented to undercount — MCP server overhead
(~40k tokens in a typical loaded config) is hidden. Anthropic's been asked
to fix it (Issue #29971) and chose not to. Their `/context` shows
"60% used"; ours shows *what 60%*.

The tool's interest is aligned with your token budget. The vendor's isn't.

See `DESIGN.md` for the full thinking on user, wedge, and where this goes
next.

## Roadmap

- **v1 (this release):** CLI status, watch, doctor. Free, OSS, Claude Code only.
- **v2:** Pre-flight hook-based budget enforcement (cap a session before it
  blows your weekly limit). Optional anonymized cross-machine sync.
- **v3:** Cursor, Cline, Gemini CLI.

## How it works

`tokenlens` reads `~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl`.
Each line is a JSON object representing one event in the session. The
relevant fields:

- `type: "assistant"` rows contain `message.usage`, Anthropic's exact
  per-turn token count (input, cache_creation, cache_read, output).
- `attributionSkill` on each assistant row identifies which skill
  Anthropic attributed the turn to.
- `type: "attachment"` rows include the literal content of injected skills,
  hook context, todo reminders, and MCP-server tool deltas.

We aggregate these, share-out each turn's cache_creation across the
attachments that preceded it (weighted by tokenized content size or a
heuristic for text-less injections), and cap per-event attribution at
1.5× weight so cache invalidations don't get falsely pinned on whatever
attachment happened to be most recent.

Full schema notes in [`docs/SCHEMA.md`](./docs/SCHEMA.md).

## Caveats

- Reverse-engineered against Claude Code v2.1.138. The session jsonl
  schema may shift on subsequent versions; tokenlens will warn if it
  encounters fields it doesn't recognize.
- The local tokenizer (`@anthropic-ai/tokenizer`) tracks the Claude 2
  era. Estimates for content tokenized locally are ±5% vs. server-side
  counts. Past-turn numbers from `message.usage` are exact.
- The `cache_invalidation_or_growth` bucket lumps together genuine cache
  TTL expirations and conversation growth — tokenlens can't yet
  distinguish between them without more session signal.

## License

MIT — see [`LICENSE`](./LICENSE).
