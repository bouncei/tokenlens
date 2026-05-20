# tokenlens — Design Deep-Dive

> Mid-session token budget guard and context inspector for Claude Code (and later Cursor, Cline, Gemini CLI).

Working name: **tokenlens**. Open to change.

This doc digs into the idea-card at `~/Documents/idea-scout/2026-05-17-general.md` (Idea 1) and converts it into a buildable v1. Sections: the user, the wedge under a microscope, the painful job-to-be-done, MVP slice, technical architecture, what we explicitly *don't* build for v1, pricing, distribution, and the hardest things to get right.

---

## 1. The user — narrower than the card

The idea card said "solo devs and 1–10 person teams paying personally for Claude Max / Pro." That's still too broad. The right v1 user is sharper:

**Beachhead user**: a solo developer who:
1. Pays personally for Claude Max ($100 or $200/mo) — i.e., the money comes out of their own bank account, not an employer
2. Uses Claude Code as their *primary* coding interface ≥4 hours per workday
3. Has hit a weekly cap mid-week at least once in the last 30 days
4. Has installed ≥3 MCP servers and ≥1 plugin (= they're a tinkerer, they care about the rig)
5. Reads HN and follows GitHub issue threads on `anthropics/claude-code`

Where to find them: the comment sections of the HN threads cited in the idea card (`#47586176`, `#47626833`), replies on the `claude-code` Issue #29971 thread, the r/ClaudeAI subreddit, Anthropic's Discord, and recent Show HN posts of Claude Code add-ons.

This is a population of *thousands*, not millions, in v1. That's fine — they're acutely paying, vocal, and they'll evangelize. Expansion to Cursor / Cline users comes after we've nailed Claude Code.

---

## 2. The wedge under a microscope

The card said: "Anthropic structurally can't ship this." Let's pressure-test that.

### Why Anthropic *won't* fix it well

1. **Revenue alignment.** Anthropic gets paid per token. A perfect "you wasted 8k tokens reloading CLAUDE.md 47 times this session" report makes Anthropic look bad and trains the user to slim down. That's revenue they leave on the table. Whatever they ship is going to be conservative.
2. **The `/context` ground truth is known to lie.** Issue #29971 documents that `/context` hides ~40k tokens of MCP overhead. They closed that issue as "not planned" in March 2026 (today: 2026-05-19). That's not a roadmap gap — it's a decision.
3. **Skill / plugin duplication serves their ecosystem.** Plugins get installed via Anthropic's plugin marketplace. Fixing skill duplication means surfacing "this plugin you installed cost you 5k tokens per turn" — that hurts the marketplace flywheel they're trying to grow.

### Why a third party can ship it

1. **Aligned incentives.** Our pitch is literally "save you 30% of your token spend." Every dollar we save you is a dollar of value we deliver. Anthropic's pitch can't say that.
2. **Read-only on the user's machine.** All the state lives in `~/.claude/` — sessions, plugins, skills, MCP config. We don't need API access, we don't need permission from Anthropic; we just need fs read.
3. **Hook into the session lifecycle.** Claude Code supports user-defined hooks in `settings.json` (PreToolUse, etc.). We can sit *between* the model and the tool call and gate it.

### Where the wedge could crumble

- Anthropic might ship a competitive "context inspector" themselves under pressure. **Mitigation**: ship fast, be the brand for the niche before they pivot, and stake out hard-budget enforcement (which they really won't ship).
- The community could converge on an open-source tool. **Mitigation**: we should *start* open-source on the inspector; charge for the daemon/cloud/sync/team features later. Don't try to fight free at the metering layer.

---

## 3. The job-to-be-done

When a user installs tokenlens, what specifically are they hiring it for?

> "It's Wednesday at 3pm. I've used 78% of my weekly Claude Max budget and I don't know why. I'm three days from reset. I need to (a) figure out what's eating it so I can disable that, and (b) stretch what's left to Friday EOD without rationing in a way that makes me less productive."

That decomposes into three concrete moments where the user pulls tokenlens out:

| Moment | Question being answered | Today's answer | Our answer |
|---|---|---|---|
| Right after `/context` says "60%" | "What 60%? Of what?" | `/context` shows skills count but not the cost of each | A real breakdown: skills 22k, MCP servers 14k, CLAUDE.md 8k, history 16k |
| Right before a big task | "Am I about to blow the rest of my week?" | No signal until it's too late | Pre-flight estimate: "this prompt + your tools will likely cost 18k. You have 41k left this week." |
| Right after a session | "Was that a normal amount?" | Nothing | Diff against your baseline session: "23% more than your median Python task" |

**Hierarchy of value**: the *third* one (post-hoc analysis) is closest to what CodeBurn already does and is the weakest moat. The *first* one (live inspector) is the brand-defining moment. The *second* one (pre-flight) is the killer hard-to-copy feature — it requires hooks integration that Anthropic doesn't make easy.

---

## 4. MVP slice (what ships in v1)

Stripped to the bone. **Goal: a thing that returns "yes, my token spend dropped" for the first 50 users within 30 days of launch.**

### v1 in scope
- [x] CLI `tokenlens status` shows the active session's token breakdown by source.
- [x] `tokenlens watch` tails the active session and re-renders on append.
- [x] `tokenlens doctor` detects + optionally fixes:
  - [x] Stale plugin versions in `~/.claude/plugins/cache/`
  - [x] Duplicate skill symlinks in `~/.claude/skills/`
- [x] Skill attribution (`attributionSkill`) and share-by-weight attachment attribution
  with cap-and-residual to surface cache invalidations honestly.
- [x] MIT-licensed, OSS.

### v1.1 follow-ups (post-launch)
- CLAUDE.md re-injection counting (need to confirm where the per-tool-call
  injection shows up in the jsonl — possibly under a different attachment type).
- MCP-server-level rollup of `deferred_tools_added` events into per-server cost.
- Per-tool "never called" detection (cross-reference `addedNames` against
  `message.content[].name` over the session).

### v1 explicitly *not* in scope
- ❌ macOS menu-bar app (Electron / Tauri / Swift). Ship CLI first; menu bar in v2.
- ❌ Cursor / Cline / Gemini CLI support. v1 is Claude Code only.
- ❌ Weekly cap projection. Needs telemetry that's brittle today.
- ❌ Pre-flight estimate before a prompt. Requires a hook integration and the hook API is still maturing.
- ❌ Auto-disable of bloated MCP servers. v1 informs; user acts.
- ❌ Cloud sync, teams features, dashboards.

### "Done" looks like
- A user can `pnpm dlx tokenlens status` (or via `npx`) and within 2 seconds see a precise breakdown of their context with > 95% agreement to a hand-counted reference session.
- The `doctor` command produces a positive delta (a real reduction in context size) on a session that hasn't been cleaned recently.
- At least one of: a GitHub star count over 500, or a Show HN thread reaching the front page, within 30 days.

---

## 5. Technical architecture (v1)

Stack: **TypeScript + Node 20+**. Why not Rust / Go: faster iteration, the parsing surface is mostly JSON, and the population of contributors who can read TS for a tool aimed at devs is much larger than for Rust. We can rewrite hot paths in Rust if profiling demands it (it won't, for v1).

```
~/.claude/
├── projects/<encoded-cwd>/*.jsonl   ← session transcript (source of truth)
├── sessions/                        ← session metadata
├── plugins/                         ← installed plugin manifests
├── skills/                          ← symlinks to skill .md files
├── settings.json                    ← user config (MCP servers, hooks)
└── telemetry/                       ← (don't read; not stable)
```

```
tokenlens/
├── src/
│   ├── index.ts              # CLI entry, command dispatch
│   ├── claude-state.ts       # Locate & read ~/.claude/ artifacts
│   ├── parsers/
│   │   ├── session.ts        # Parse session jsonl → typed turn events
│   │   ├── system-prompt.ts  # Decompose a system prompt into sources
│   │   ├── skills.ts         # Detect skill duplicates / stale versions
│   │   ├── mcp.ts            # Read settings.json MCP config; tally tool defs
│   │   └── plugins.ts        # Walk plugin cache; detect multi-version installs
│   ├── tokens/
│   │   └── count.ts          # Token counting via tiktoken / @anthropic-ai/tokenizer
│   ├── commands/
│   │   ├── status.ts
│   │   ├── watch.ts
│   │   └── doctor.ts
│   ├── ui/
│   │   ├── breakdown.tsx     # Ink (React for CLI) component
│   │   └── live.tsx
│   └── lib/
│       ├── format.ts         # Number formatting, color
│       └── fs-watch.ts       # chokidar wrapper
├── tests/
│   ├── fixtures/             # Anonymized session jsonl samples
│   └── parsers/
├── package.json
├── tsconfig.json
└── README.md
```

### Key technical questions to resolve before v1 ships

1. **How exactly does Claude Code's `~/.claude/projects/<id>/*.jsonl` encode the system prompt?** Need to find: is the full system prompt rendered into the first turn's payload, or is it stored separately? If separately, where? This is the single most important reverse-engineering step. (No public docs; we'll read the open-source `claude-code` repo or do empirical inspection.)

2. **Which tokenizer?** Anthropic's models use a tokenizer close to but not identical to `tiktoken` cl100k. The `@anthropic-ai/tokenizer` package exists but tracks Claude 2 era; Claude 4 tokenization differs. For v1 we use `@anthropic-ai/tokenizer` and clearly label estimates as "approx ±5%."

3. **Where do MCP token costs actually come from?** Each MCP server contributes (a) its tool definitions (JSON schemas) injected into the system prompt and (b) any tool-call results during the conversation. We need to count both separately.

4. **How do we count CLAUDE.md re-injection across a session?** Per Issue #29971, project CLAUDE.md is re-injected on *every tool call*. So count = number of tool-call turns × file size. Verify empirically on a sample session.

5. **Hooks for the pre-flight estimate (v2).** Claude Code's `settings.json` supports `hooks.PreToolUse`. A v2 feature would register a hook that runs `tokenlens estimate` before each tool call and prompts the user. Need to check current hook API stability.

### Token counting precision

- **Acceptable for v1**: ±5% absolute error vs. Anthropic's actual counter.
- **Strategy**: use `@anthropic-ai/tokenizer`, calibrate against any tokens-used numbers we can find in the session jsonl (the assistant's own usage reports), and clearly mark numbers as "estimate."

---

## 6. Distribution & pricing

### v1 (months 0–3): free, OSS, viral
- MIT-licensed on GitHub. `pnpm dlx tokenlens` and `npx tokenlens`.
- Hard-launch as a Show HN post. Title testable in advance — e.g., "Show HN: I'm wasting 30% of my Claude Code tokens on dupe skills. Here's the diagnostic."
- Co-launch a 1,500-word blog post: "I read Issue #29971 and built the tool Anthropic won't ship."
- Goal: 1,000 unique installs, 500 GitHub stars, a presence in the conversation.

### v2 (months 3–6): paid features behind same CLI
- `tokenlens cloud` — optional sync of anonymized session telemetry across machines, weekly cap projection, team aggregates. $9/mo solo, $19/user team.
- `tokenlens guard` — pre-flight hook integration that hard-caps token spend per task. Same price.
- Free tier stays useful forever; we don't cripple it.

### v3 (months 6–12): expand surfaces
- Cursor support (read `~/.cursor/`).
- Cline support.
- Gemini CLI support.

The OSS-first move matters because the buyer here is *technical and distrusts paid trackers eating their data*. Free CLI + opt-in paid sync is the only credible shape.

---

## 7. Risks & open questions

| Risk | Severity | Mitigation |
|---|---|---|
| Anthropic ships a real `/context` rewrite that obsoletes us | High | Stake out hard budget enforcement (v2) — they won't go there |
| The `~/.claude/` schema changes underneath us | Medium | Pin tested versions, fail loud with a clear error, add a public compatibility matrix |
| Tokenizer drift makes our counts visibly off | Medium | Always show "approx," add a calibration command (`tokenlens calibrate` against a known prompt+API response) |
| MCP server count varies wildly across users → no consistent demo | Low | Bundle two reference profiles ("clean dev," "MCP-heavy") in tests |
| Open source kills the upgrade path | Medium | Keep the core OSS, make sync / hooks / projections paid; lean into team features |

### Validation experiments before writing more code

1. **Inspect 3 real `~/.claude/projects/<id>/*.jsonl` files** (mine + two recruited testers) and confirm the schema.
2. **Reproduce the four bloat classes from Issue #29971** on a real session — does our parser detect them?
3. **Talk to 5 of the users from HN #47586176 comments.** Show them a CLI mockup of `tokenlens status` and watch their reaction. If 4/5 don't ask to be on a beta list, the wedge is wrong.

---

## 8. What I'd build in week 1

Day 1–2: `claude-state.ts` + `session.ts` parser. Can read a jsonl, emit typed events. Tested against a real session.

Day 3: `system-prompt.ts` decomposer. Given the first assistant turn, partition by source (CLAUDE.md, skills, MCP defs, etc.). Tested against a hand-labeled session.

Day 4: `tokens/count.ts` + `commands/status.ts`. Stitch them together. `tokenlens status` produces a readable breakdown.

Day 5: `parsers/skills.ts` + `parsers/plugins.ts` + `commands/doctor.ts`. Detects the duplicate-skill / stale-plugin pathologies and offers to fix them.

Day 6: Ink-based TUI for `commands/watch.ts`. Live updates on changes to the active session jsonl via chokidar.

Day 7: README, screenshots, anonymizer for the test fixtures, prepare Show HN draft.

If days 1–3 reveal that the session jsonl doesn't actually contain the system prompt verbatim, **stop and re-plan** — the whole project depends on being able to count what's in context.

---

## 9. Decisions deferred (capture them when made)

- [x] Final name: **tokenlens** (kept; replace later if a better one surfaces).
- [x] License: **MIT**.
- [ ] Telemetry: do we ever phone home from the CLI? Default off, opt-in for "help us improve detection rules."
- [ ] Should we ship a `tokenlens lint` command that runs in CI on a repo's `.claude/` config?
- [ ] Pricing tier names for v2.
