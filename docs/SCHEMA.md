# Claude Code session jsonl — schema notes

Reverse-engineered from `~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl` on Claude Code **v2.1.138**, captured 2026-05-19. Treat as a moving target — re-check on every Claude Code minor version bump.

## File location

- Path: `~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl`
- Encoding for `<encoded-cwd>`: split the cwd by `/`, replace `.` with `-` in each segment, join with `-`. The leading slash produces a leading `-`.
  - `/Users/josh/foo`        → `-Users-josh-foo`
  - `/Users/josh/foo/.bar/x` → `-Users-josh-foo--bar-x`  (note the double `-` from `.bar`)
- One file per session. Append-only during a live session.
- Format: JSON Lines (one JSON object per line, no commas).

## Top-level types

| `type`            | Count (sample session) | Purpose |
|---|---|---|
| `assistant`       | 109 | Model response (text/thinking/tool_use) + token `usage` |
| `user`            |  76 | User message OR tool_result returning to model |
| `last-prompt`     |  17 | Pointer to the leaf UUID of the last user prompt (for UI) |
| `attachment`      |  15 | System-injected content (skills, MCP deltas, hook output, reminders) |
| `queue-operation` |   6 | Input queue enqueue/dequeue events |
| `system`          |   3 | API errors with retry state and HTTP headers |

Common envelope fields on most rows: `sessionId`, `timestamp`, `uuid`, `parentUuid`, `cwd`, `gitBranch`, `version` (Claude Code version), `entrypoint`, `userType`, `isSidechain`.

## `assistant` — model response

Critical for token accounting. Shape:

```jsonc
{
  "type": "assistant",
  "uuid": "<turn uuid>",
  "parentUuid": "<previous turn uuid>",
  "sessionId": "...",
  "timestamp": "2026-05-19T...",
  "requestId": "...",
  "attributionSkill": "idea-scout",        // ← skill blamed for this turn (nullable)
  "message": {
    "id": "msg_...",
    "model": "claude-opus-4-7",
    "role": "assistant",
    "type": "message",
    "content": [
      { "type": "thinking",  "thinking": "...", "signature": "..." },
      { "type": "text",      "text": "..." },
      { "type": "tool_use",  "id": "...", "name": "Read", "input": {...}, "caller": { "type": "..." } }
    ],
    "stop_reason": "tool_use",
    "stop_details": {...},
    "stop_sequence": null,
    "usage": {
      "input_tokens":               5,         // non-cached input
      "cache_creation_input_tokens": 22297,    // tokens written to cache this turn
      "cache_read_input_tokens":     18472,    // tokens read from cache (cheap)
      "output_tokens":                667,
      "cache_creation": {
        "ephemeral_5m_input_tokens": 0,
        "ephemeral_1h_input_tokens": 22297     // most caches use the 1h TTL
      },
      "iterations": [                          // per-iteration breakdown when the
        {                                      // turn fires multiple completions
          "input_tokens": 5,
          "output_tokens": 667,
          "cache_read_input_tokens": 18472,
          "cache_creation_input_tokens": 22297,
          "type": "..."
        }
      ],
      "server_tool_use": {
        "web_search_requests": 0,
        "web_fetch_requests": 0
      },
      "service_tier": "standard",
      "speed": null,
      "inference_geo": ""
    },
    "diagnostics": null                        // populated on cache miss with
                                               // cache_miss_reason.type +
                                               // cache_missed_input_tokens
  }
}
```

**Headline**: `message.usage` is the API's ground-truth token count. We do not need to re-tokenize anything for *past* turns — Anthropic has already done it for us.

## `user` — user prompt OR tool result

```jsonc
{
  "type": "user",
  "uuid": "...",
  "parentUuid": "...",
  "promptId": "...",
  "isMeta": false,
  "message": {
    "role": "user",
    "content": [
      // Either a plain text user message:
      { "type": "text", "text": "..." },

      // Or a tool_result returning to the model:
      {
        "type": "tool_result",
        "tool_use_id": "...",
        "content": [ { "type": "text", "text": "..." } ]
      }
    ]
  },
  // Some rows also embed a structured summary:
  "toolUseResult": {
    "durationSeconds": 1.2,
    "matches": [...],
    "newTodos": [...],
    "oldTodos": [...],
    "query": "...",
    "results": [...],
    "total_deferred_tools": 198
  },
  "sourceToolAssistantUUID": "..."
}
```

## `attachment` — system-injected content

The most important type for **context-cost attribution**. The `attachment.type` distinguishes the source:

| `attachment.type`           | What it is | Key fields | Token cost? |
|---|---|---|---|
| `hook_success`              | Hook stdout/stderr from PreToolUse, SessionStart, etc. | `hookName`, `hookEvent`, `stdout`, `stderr`, `exitCode`, `durationMs`, `command` | usually small |
| `hook_system_message`       | Hook-emitted notice surfaced to user | `content`, `hookName`, `hookEvent` | usually small |
| `hook_additional_context`   | **Hook-injected content that becomes context.** Body of skills like `using-superpowers` lives here. | `content` (list of strings), `hookName`, `hookEvent` | **often huge** |
| `skill_listing`             | The full skill descriptions block (the `<system-reminder>` listing N skills with their descriptions) | `content` (string), `skillCount`, `isInitial` | **medium–large** |
| `deferred_tools_delta`      | Tools added/removed dynamically. Mirrors MCP-server connect/disconnect lifecycle and ToolSearch results. | `addedNames[]`, `addedLines[]`, `removedNames[]`, `readdedNames[]`, `pendingMcpServers[]` | each tool's full schema lives elsewhere; the *delta* is small |
| `todo_reminder`             | `<system-reminder>` reminding the model to use TodoWrite | — | small, fires repeatedly |
| `date_change`               | Notification that the calendar date rolled over | — | tiny |
| `command_permissions`       | Permission state for tools | — | varies |
| `auto_mode`                 | Auto-mode session metadata | — | tiny |

Common envelope on all attachments: `attachment.toolUseID`, `cwd`, `gitBranch`, `version`, plus the standard envelope.

### How to count attachment cost

For `hook_additional_context` and `skill_listing`, the `content` field literally is the injected text. Tokenize it (with `@anthropic-ai/tokenizer`) to estimate cost. The estimate will be ±5% of what Anthropic actually charged — to get the precise number, sum `cache_creation_input_tokens` on the *first* assistant turn that follows the injection.

For `deferred_tools_delta`, the names listed are tool names only; the full tool schemas (with descriptions, JSON-schema args) are injected by the runtime elsewhere and not visible in the jsonl as a single block. You have two options:
1. Estimate: ~150–600 tokens per tool definition (varies wildly).
2. Subtract: take the observed `cache_creation_input_tokens` jump after the delta and attribute the delta to those tools.

## `last-prompt`

Minimal: just `{ leafUuid, sessionId, type: "last-prompt" }`. Used by the UI to find the active prompt thread; safe to ignore for token accounting.

## `queue-operation`

Input queue lifecycle events. `operation` is `enqueue` / `dequeue`. `content` is the user's raw input. Useful for matching session start to wall-clock time; not needed for token math.

## `system`

API errors. Includes `error.error` (with `type`, `message`, `request_id`), HTTP headers, `retryAttempt`, `retryInMs`, `maxRetries`, `stopReason`, `preventedContinuation`. Useful for showing "the rate limit was hit at <time>" but optional for v1.

## Sample-session totals (this conversation's session, mid-stream)

- Assistant turns: 109
- `input_tokens` (uncached): 38,656
- `cache_creation_input_tokens`: 905,682
- `cache_read_input_tokens`: 10,365,871
- `output_tokens`: 145,260
- Cache hit rate: 92.0%
- Pricing model (Claude Opus 4.7): cache reads are ~10% of normal input price; cache writes are ~125% of normal input price.

## Open questions for v1

1. **Where does the literal system prompt live?** Not in any single line of the jsonl. Composed at runtime from settings.json + hooks + skills + plugins. For v1 we don't need the literal text — we attribute via the cache-creation jumps and the per-source attachment content.
2. **Are there other `attachment.type` values in the wild we haven't seen?** Need to inspect a few more sessions.
3. **Does `attributionSkill` ever attribute to plugins / non-skill sources?** This sample only contained `idea-scout`. Need more data.
4. **What does `message.diagnostics.cache_miss_reason` look like when it's populated?** It's `null` in this clean session. We need a session with a real cache miss to see the shape.

## Versioning

Pin to `version` from the envelope. Bail with a clear error if we see a version we haven't tested. Re-record this doc on every Claude Code minor.
