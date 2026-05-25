# tokenlens

[![npm](https://img.shields.io/npm/v/@bouncei/tokenlens.svg)](https://www.npmjs.com/package/@bouncei/tokenlens)
[![ci](https://github.com/bouncei/tokenlens/actions/workflows/ci.yml/badge.svg)](https://github.com/bouncei/tokenlens/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Node.js](https://img.shields.io/badge/node-%E2%89%A520-green)](https://nodejs.org)

**See exactly what's eating your Claude Code context window — and stop it.**

```bash
npx -y @bouncei/tokenlens status
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
  turns    278 assistant

Tokens consumed by Anthropic
  input (uncached)           38.9k
  cache writes               2.07M   ← bloat lives here
  cache reads               41.21M   ← cheap
  output                    298.4k
  cache hit rate             95.2%

Output by attributionSkill
  <unattributed>          ████████████████   208.7k   (213 turns)
  idea-scout              ██████░░░░░░░░░░    92.6k   (65 turns)

Injected context by source
  cache_invalidation_or_growth  ████████████████ ! 520.3k   across 16 turns
  deferred_tools_added          █░░░░░░░░░░░░░░░ ~  25.0k   3 ev, 0 B text
  skill_listing                 ░░░░░░░░░░░░░░░░     1.5k   1 ev, 13.3 KB text
  hook_additional_context       ░░░░░░░░░░░░░░░░      791   1 ev, 5.5 KB text

MCP servers (loaded vs. invoked)
  (~50.5k estimated on tools never called)
  7dfd9fcf…               ████████████ ~  10.3k   ● never called
  plugin_playwright_playw…███████░░░░░ ~   5.8k   ● never called
  playwright              ███████░░░░░ ~   5.8k   ● never called
  Claude_in_Chrome        ██████░░░░░░ ~   5.5k   ● never called
  filesystem              ████░░░░░░░░ ~   3.5k   ● never called
  memory                  ███░░░░░░░░░ ~   2.3k   ● never called
  ...
  202 dead tools (use --show-dead for full list)
```

Two findings worth the install on their own:

1. **~50,500 tokens** of context overhead this session was spent on **MCP tools that were never invoked**. Every server I had loaded — filesystem, memory, playwright, all 10 of them — got definition-injected and never called. That's `/context` reporting "you're at 60%" while 25% of the load is dead weight you could disable with one line in `.mcp.json`.

2. **520k tokens** were written to cache as part of TTL-expiry invalidations across 16 separate moments — roughly $4 of cache-write cost on Opus, paid silently across the session and **invisible to `/context`**. `tokenlens` names it as `cache_invalidation_or_growth` so you can see when it's happening.

## Commands

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

### `tokenlens init` and `tokenlens budget` (v2 preview)

Configure a weekly token budget and check your current session against it:

```bash
tokenlens init --tier max5      # writes ~/.claude/tokenlens.json with sane defaults
tokenlens budget                # shows: ALLOW / WARN / ASK / DENY vs your budget
```

These are the building blocks for v2's `PreToolUse` hook — see "v2 preview" below.

## v2 preview — proactive budget enforcement (testable today)

The next surface is a Claude Code plugin that runs on every tool call and:

- **Silently allows** if you're under 50% of your weekly cap
- **Injects a warning** into Claude's context at 50–80% (Claude can decide to wrap up early)
- **Asks for confirmation** at 80–95% (you click through)
- **Denies** at 95%+ (or earlier if `hardCap: true` in your config)

It's already wired up. Test it locally:

```bash
git clone https://github.com/bouncei/tokenlens.git
cd tokenlens
pnpm install                                # builds dist/
tokenlens init --tier max5                  # writes ~/.claude/tokenlens.json
claude --plugin-dir ./tokenlens-cc          # loads the plugin
```

Now every tool call hits the budget evaluator. Watch the decisions in `~/.claude/tokenlens.log`. The PreToolUse hook contract is fail-allow — a misbehaving hook will never block your workflow.

Marketplace submission to `claude-plugins-community` is pending.

## How it works

`tokenlens` reads `~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl`. The session log already contains Anthropic's ground-truth per-turn token counts, so for past turns `tokenlens` reports exact numbers — not estimates.

Each line is a JSON object representing one event in the session. The relevant fields:

- `type: "assistant"` rows contain `message.usage`: Anthropic's exact per-turn token count (input, cache_creation, cache_read, output, including the ephemeral_5m vs ephemeral_1h cache split).
- `attributionSkill` on each assistant row identifies which skill Anthropic attributed the turn to.
- `type: "attachment"` rows include the literal content of injected skills, hook context, todo reminders, and MCP-server tool deltas.

We aggregate these, share-out each turn's cache_creation across the attachments that preceded it (weighted by tokenized content size, or a heuristic for text-less injections), and cap per-event attribution at 1.5× weight so cache invalidations don't get falsely pinned on whatever attachment happened to be most recent.

Full schema notes in [`docs/SCHEMA.md`](./docs/SCHEMA.md).

## Install (other paths)

The fastest install is `npx`, but if you want a stable binary on `$PATH`:

```bash
# Globally
pnpm add -g @bouncei/tokenlens
# or
npm install -g @bouncei/tokenlens

# From source
git clone https://github.com/bouncei/tokenlens.git
cd tokenlens
pnpm install      # also builds dist/ via the prepare script
./dist/index.js status
```

Published on npm: [`@bouncei/tokenlens`](https://www.npmjs.com/package/@bouncei/tokenlens).

Requires Node.js 20 or newer.

## Roadmap

- **v1 (shipped, v0.1.0):** CLI `status`, `watch`, `doctor`, `init`, `budget`. Free, OSS.
- **v2 (in progress, testable now):** [`tokenlens-cc`](./tokenlens-cc/) plugin wiring tokenlens into Claude Code's `PreToolUse` hook — proactive budget warnings, hard caps, and session-context injection. Pending community marketplace review. Free tier stays free; paid tier ($9–19/mo) adds cross-machine sync, weekly digest, team views (not yet built).
- **v3 (next 12 months):** Same value prop, cross-IDE. Cursor, Cline, Gemini CLI.

See [`DESIGN.md`](./DESIGN.md) for the architecture overview.

## Caveats

- Reverse-engineered against Claude Code v2.1.138 (May 2026). The session jsonl schema may shift on subsequent versions; tokenlens preserves unknown fields and won't crash on them.
- The local tokenizer (`@anthropic-ai/tokenizer`) tracks the Claude 2 era. Estimates for content we tokenize locally are ±5% vs. server-side counts. **Past-turn numbers from `message.usage` are exact.**
- The `cache_invalidation_or_growth` bucket lumps together genuine cache TTL expirations and conversation growth — tokenlens can't yet distinguish them without more session signal. Working on it.

## Contributing

Issues and PRs welcome. The project is small and the surface is well-bounded — start with [`docs/SCHEMA.md`](./docs/SCHEMA.md) to understand the session jsonl format, then [`CONTRIBUTING.md`](./CONTRIBUTING.md) for how to add a new attachment category or analyzer.

If your `~/.claude/` has a structure tokenlens doesn't recognize, please open an issue with a sample line (anonymized) — every new attachment type we map deepens the wedge.

## License

MIT — see [`LICENSE`](./LICENSE).
