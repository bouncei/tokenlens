# Contributing to tokenlens

Two paths for first-time contributors:

1. **Found a schema mismatch on your Claude Code version?** Open a bug with one or two anonymized jsonl lines (see the bug template). The session schema is reverse-engineered against v2.1.138 — every confirmation that it still works (or doesn't) on newer versions is genuinely useful.
2. **Built a new attachment-category detector or a new analyzer?** PR welcome. See "Anatomy" below.

## Anatomy

```
src/
├── parsers/session.ts    # Streaming JSON-line parser with typed row taxonomy
├── attribute.ts          # Share-by-weight attribution + cache_invalidation bucket
├── analyze/
│   └── tools.ts          # "Tools never called" detector + per-server rollup
├── claude-state.ts       # ~/.claude path conventions + session discovery
├── tokens/count.ts       # Local tokenizer + heuristic constants
├── format.ts             # bar charts, padding, byte/token formatters
├── commands/
│   ├── status.ts         # One-shot breakdown
│   ├── watch.ts          # chokidar-tail live view
│   └── doctor.ts         # Issue #29971 remediations
└── index.ts              # CLI entrypoint
```

`docs/SCHEMA.md` is the source of truth for the session jsonl format. If you confirm a new field or attachment type, update SCHEMA.md in the same PR.

`docs/GOAL.md` is the source of truth for what's in scope. The anti-goals section is what we say no to — if your PR adds a feature that lives in an anti-goal bucket, it probably won't land.

## Running locally

```bash
git clone https://github.com/bouncei/tokenlens.git
cd tokenlens
pnpm install                # also runs `tsc && chmod +x dist/index.js`
pnpm dev status             # runs against your own current cwd's session
pnpm test                   # 19 tests, all unit
pnpm typecheck
```

## Adding a new attachment category

1. Grep your own session for the new `attachment.type` string:
   ```bash
   jq -s 'map(select(.type == "attachment") | .attachment.type) | unique' \
     ~/.claude/projects/<encoded-cwd>/<session>.jsonl
   ```
2. Add the type to `KNOWN_CATEGORIES` and `SourceCategory` in `src/attribute.ts`.
3. If it carries text payload, the existing `attachmentText()` will find it. If it's structural (like `deferred_tools_delta`), add a heuristic weight in `weighAttachment()`.
4. Document the type and its shape in `docs/SCHEMA.md` under the attachment table.
5. Run `pnpm test` — the existing tests should keep passing.

## Adding a new analyzer

`src/analyze/tools.ts` is the template. The shape:

```ts
export function analyzeFoo(rows: SessionRow[]): FooResult { ... }
```

Read the rows you need, return a plain object, sort however makes sense for display. Then wire it into `src/commands/status.ts` as a new section.

## Submitting a fresh schema snippet

When you file a bug or PR that involves a new attachment type, please include a one-line anonymized example. Replace these fields with placeholders:

| Field | Replace with |
|---|---|
| `cwd` | `<redacted-cwd>` |
| any path under `cwd` | `<redacted-path>` |
| `gitBranch` | `<redacted-branch>` |
| `sessionId`, `uuid`, `parentUuid` | keep (these are random and have no PII) |
| `attachment.content` if it contains file contents | replace text body with `<redacted-content-NNN-chars>` |

We don't need full sessions — single anonymized rows are enough to confirm a new schema variant.

## Anti-goals reminder

We will not merge:

- Features that duplicate `/context` (Anthropic could ship those themselves).
- Generic LLM observability features (Langfuse / Phoenix / Braintrust serve that market).
- Token pricing calculators for arbitrary models.
- SaaS dashboard scaffolding before the CLI is solid.

See `docs/GOAL.md` for the full rationale. If your PR is in an adjacent space and you're not sure, open an issue first.

## License

By contributing, you agree your contributions are licensed under MIT, matching the repo.
