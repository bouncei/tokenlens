#!/usr/bin/env node
// tokenlens-cc PreToolUse + SessionStart hook script.
//
// Receives the hook event JSON on stdin, evaluates the user's budget
// from ~/.claude/tokenlens.json, and emits the appropriate hook
// response JSON on stdout. Designed to *fail-allow* — any unexpected
// error logs to ~/.claude/tokenlens.log but emits an "allow" so
// hook failures never break the user's workflow.

import { existsSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseSession, type SessionRow } from "./parsers/session.js";
import { loadConfig, evaluateBudget } from "./budget.js";

const LOG = join(homedir(), ".claude", "tokenlens.log");

function log(msg: unknown): void {
  try {
    const line = `[${new Date().toISOString()}] ${typeof msg === "string" ? msg : JSON.stringify(msg)}\n`;
    appendFileSync(LOG, line);
  } catch {
    /* ignore */
  }
}

function emitAllow(): never {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
      },
    }),
  );
  process.exit(0);
}

process.on("uncaughtException", (err) => {
  log({ uncaught: String(err), stack: (err as Error).stack });
  emitAllow();
});

interface HookInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  source?: string;
}

async function main(): Promise<void> {
  // 1. Read stdin (the hook input JSON).
  const stdinChunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    stdinChunks.push(chunk as Buffer);
  }
  const stdinRaw = Buffer.concat(stdinChunks).toString("utf8");

  let input: HookInput;
  try {
    input = stdinRaw.trim() ? (JSON.parse(stdinRaw) as HookInput) : {};
  } catch (err) {
    log({ parseError: String(err), stdin: stdinRaw.slice(0, 200) });
    return emitAllow();
  }

  // 2. SessionStart: informational only.
  if (input.hook_event_name === "SessionStart") {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          systemMessage:
            "tokenlens loaded. Run `tokenlens status` in another terminal for a live breakdown, or `tokenlens watch` to keep it open.",
        },
      }),
    );
    process.exit(0);
  }

  // 3. PreToolUse: evaluate against budget.
  const transcript = input.transcript_path;
  if (!transcript || !existsSync(transcript)) {
    log({ skip: "no transcript", input });
    return emitAllow();
  }

  let rows: SessionRow[];
  let config: Awaited<ReturnType<typeof loadConfig>>;
  try {
    rows = await parseSession(transcript);
    config = await loadConfig();
  } catch (err) {
    log({ parseSessionError: String(err) });
    return emitAllow();
  }

  const evaluation = evaluateBudget(rows, config);
  log({
    event: "PreToolUse",
    tool: input.tool_name,
    decision: evaluation.decision,
    consumed: evaluation.consumed,
    percent: Math.round(evaluation.percentUsed * 100),
  });

  const out = (() => {
    switch (evaluation.decision) {
      case "allow":
        return {
          hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" },
        };
      case "warn":
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "allow",
            additionalContext: evaluation.contextMessage,
          },
        };
      case "ask":
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "ask",
            permissionDecisionReason: evaluation.userMessage,
          },
        };
      case "deny":
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: evaluation.userMessage,
          },
        };
    }
  })();

  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

main().catch((err) => {
  log({ mainError: String(err), stack: (err as Error).stack });
  emitAllow();
});
